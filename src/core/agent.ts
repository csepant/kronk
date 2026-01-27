/**
 * Kronk Agent Core
 * 
 * The main agent class that orchestrates memory, tools, journal,
 * and LLM interactions for autonomous operation.
 */

import type { KronkInstance, KronkConfig } from '../init/index.js';
import type { Memory, ContextWindow, EmbeddingProvider } from '../memory/manager.js';
import type { Tool, ToolHandler } from '../tools/manager.js';
import type { JournalEntry } from '../journal/manager.js';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMProvider {
  /** Generate a completion */
  complete(messages: Message[], options?: {
    temperature?: number;
    maxTokens?: number;
    tools?: Tool[];
  }): Promise<{
    content: string;
    toolCalls?: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }>;
    tokensUsed: number;
  }>;
}

export interface AgentOptions {
  /** LLM provider for completions */
  llm: LLMProvider;
  /** Embedding provider for vector search */
  embedder: EmbeddingProvider;
  /** Maximum iterations per run */
  maxIterations?: number;
  /** Whether to auto-journal actions */
  autoJournal?: boolean;
  /** Custom system prompt additions */
  systemPromptAdditions?: string;
}

export type AgentState = 'idle' | 'thinking' | 'acting' | 'observing' | 'reflecting';

export interface RunResult {
  success: boolean;
  response: string;
  iterations: number;
  tokensUsed: number;
  journalEntries: JournalEntry[];
  memoriesCreated: Memory[];
  error?: string;
}

export class Agent {
  private instance: KronkInstance;
  private llm: LLMProvider;
  private embedder: EmbeddingProvider;
  private maxIterations: number;
  private autoJournal: boolean;
  private systemPromptAdditions: string;
  private state: AgentState = 'idle';

  constructor(instance: KronkInstance, options: AgentOptions) {
    this.instance = instance;
    this.llm = options.llm;
    this.embedder = options.embedder;
    this.maxIterations = options.maxIterations ?? 10;
    this.autoJournal = options.autoJournal ?? true;
    this.systemPromptAdditions = options.systemPromptAdditions ?? '';

    // Connect embedder to managers
    this.instance.memory.setEmbedder(this.embedder);
    this.instance.journal.setEmbedder(this.embedder);
  }

  /**
   * Get the current agent state
   */
  getState(): AgentState {
    return this.state;
  }

  /**
   * Get the agent configuration
   */
  getConfig(): KronkConfig {
    return this.instance.config;
  }

  /**
   * Run the agent with a user message
   */
  async run(userMessage: string): Promise<RunResult> {
    const result: RunResult = {
      success: false,
      response: '',
      iterations: 0,
      tokensUsed: 0,
      journalEntries: [],
      memoriesCreated: [],
    };

    try {
      // Start session if not active
      if (!this.instance.journal.getSessionId()) {
        await this.instance.journal.startSession({
          goal: userMessage.slice(0, 200),
        });
      }

      // Log user input
      if (this.autoJournal) {
        const entry = await this.instance.journal.observation(`User: ${userMessage}`);
        result.journalEntries.push(entry);
      }

      // Build context
      const context = await this.instance.memory.buildContextWindow();
      const tools = await this.instance.tools.listEnabled();

      // Run agent loop
      let messages: Message[] = [
        { role: 'system', content: await this.buildSystemPrompt(context, tools) },
        { role: 'user', content: userMessage },
      ];

      while (result.iterations < this.maxIterations) {
        result.iterations++;
        this.state = 'thinking';

        // Get LLM response
        const completion = await this.llm.complete(messages, { tools });
        result.tokensUsed += completion.tokensUsed;

        // Log thought
        if (this.autoJournal) {
          const entry = await this.instance.journal.thought(
            `Iteration ${result.iterations}: ${completion.content.slice(0, 500)}`,
            { tokensUsed: completion.tokensUsed }
          );
          result.journalEntries.push(entry);
        }

        // Handle tool calls
        if (completion.toolCalls && completion.toolCalls.length > 0) {
          this.state = 'acting';

          for (const toolCall of completion.toolCalls) {
            const startTime = Date.now();
            const toolResult = await this.instance.tools.invoke(
              toolCall.name,
              toolCall.arguments
            );
            const duration = Date.now() - startTime;

            // Find tool for logging
            const tool = tools.find(t => t.name === toolCall.name);

            // Log action
            if (this.autoJournal) {
              const entry = await this.instance.journal.action(
                `Called ${toolCall.name}`,
                tool?.id ?? '',
                JSON.stringify(toolCall.arguments),
                JSON.stringify(toolResult.result ?? toolResult.error),
                duration
              );
              result.journalEntries.push(entry);
            }

            // Add tool result to messages
            messages.push({
              role: 'assistant',
              content: `Tool call: ${toolCall.name}\nArguments: ${JSON.stringify(toolCall.arguments)}`,
            });
            messages.push({
              role: 'user',
              content: `Tool result: ${JSON.stringify(toolResult.result ?? { error: toolResult.error })}`,
            });
          }

          continue; // Get next LLM response with tool results
        }

        // No tool calls - this is the final response
        result.response = completion.content;
        result.success = true;

        // Store interaction in short-term memory
        this.state = 'observing';
        const memory = await this.instance.memory.store({
          tier: 'system1',
          content: `User: ${userMessage}\nAssistant: ${completion.content}`,
          summary: `Conversation about: ${userMessage.slice(0, 100)}`,
          source: 'agent',
          tags: ['conversation'],
        });
        result.memoriesCreated.push(memory);

        break;
      }

      // Check if we hit max iterations
      if (!result.success) {
        result.error = `Reached maximum iterations (${this.maxIterations})`;
        if (this.autoJournal) {
          await this.instance.journal.error(result.error);
        }
      }

    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      if (this.autoJournal) {
        await this.instance.journal.error(`Agent error: ${result.error}`);
      }
    } finally {
      this.state = 'idle';
    }

    return result;
  }

  /**
   * Add a memory to the agent
   */
  async remember(content: string, options: {
    tier?: 'system2' | 'working' | 'system1';
    tags?: string[];
    importance?: number;
  } = {}): Promise<Memory> {
    return this.instance.memory.store({
      tier: options.tier ?? 'working',
      content,
      tags: options.tags,
      importance: options.importance,
      source: 'user',
    });
  }

  /**
   * Search agent memories
   */
  async recall(query: string, limit = 5): Promise<Array<Memory & { similarity: number }>> {
    return this.instance.memory.search(query, { limit });
  }

  /**
   * Register a tool with the agent
   */
  async registerTool(
    name: string,
    description: string,
    schema: Tool['schema'],
    handler: ToolHandler
  ): Promise<Tool> {
    const tool = await this.instance.tools.register({
      name,
      description,
      schema,
      handler: `runtime:${name}`,
    });
    this.instance.tools.registerHandler(name, handler);
    return tool;
  }

  /**
   * Trigger memory consolidation
   */
  async consolidate(summarizer: (memories: Memory[]) => Promise<string>): Promise<void> {
    this.state = 'reflecting';
    try {
      await this.instance.memory.consolidate('system1', summarizer);
      await this.instance.memory.consolidate('working', summarizer);
      await this.instance.memory.consolidate('system2', summarizer);
    } finally {
      this.state = 'idle';
    }
  }

  /**
   * Apply memory decay
   */
  async decayMemories(): Promise<number> {
    return this.instance.memory.applyDecay();
  }

  /**
   * Get agent statistics
   */
  async getStats(): Promise<{
    memory: Awaited<ReturnType<typeof this.instance.memory.getStats>>;
    journal: Awaited<ReturnType<typeof this.instance.journal.getSessionStats>>;
    tools: number;
  }> {
    const [memory, journal, tools] = await Promise.all([
      this.instance.memory.getStats(),
      this.instance.journal.getSessionStats(),
      this.instance.tools.listEnabled(),
    ]);

    return {
      memory,
      journal,
      tools: tools.length,
    };
  }

  /**
   * Reflect on recent activity
   */
  async reflect(): Promise<JournalEntry> {
    this.state = 'reflecting';
    try {
      const recentEntries = await this.instance.journal.getRecent(20);
      const narrative = await this.instance.journal.formatAsNarrative(20);

      // Use LLM to generate reflection
      const completion = await this.llm.complete([
        {
          role: 'system',
          content: `You are an AI agent reflecting on your recent activity. 
Analyze the following activity log and provide insights about:
- What worked well
- What could be improved
- Patterns you notice
- Suggestions for future actions

Be concise and actionable.`,
        },
        { role: 'user', content: narrative },
      ]);

      const reflection = await this.instance.journal.reflection(completion.content, {
        tokensUsed: completion.tokensUsed,
      });

      // Store reflection in working memory
      await this.instance.memory.store({
        tier: 'working',
        content: completion.content,
        summary: 'Recent self-reflection and insights',
        source: 'inference',
        tags: ['reflection', 'meta'],
        importance: 0.7,
      });

      return reflection;
    } finally {
      this.state = 'idle';
    }
  }

  /**
   * Build the system prompt with memory context and tools
   */
  private async buildSystemPrompt(context: ContextWindow, tools: Tool[]): Promise<string> {
    const constitution = await this.instance.memory.formatContextForPrompt(context);
    const toolPrompt = await this.instance.tools.generateToolPrompt();

    return `# Agent: ${this.instance.config.name}

## Constitution & Memory
${constitution}

## Available Tools
${toolPrompt}

## Instructions
- Use your memory to maintain context across interactions
- Log important decisions and observations
- Use tools when they help accomplish the user's goals
- Be honest about limitations and uncertainties
- Learn from mistakes and adapt your approach

${this.systemPromptAdditions}`;
  }

  /**
   * Cleanup and close connections
   */
  async shutdown(): Promise<void> {
    await this.instance.journal.endSession();
    await this.instance.db.close();
  }
}
