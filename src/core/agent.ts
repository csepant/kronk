/**
 * Kronk Agent Core
 *
 * The main agent class that orchestrates memory, tools, journal,
 * and LLM interactions for autonomous operation.
 */

import { EventEmitter } from 'node:events';
import type { KronkInstance, KronkConfig } from '../init/index.js';
import type { Memory, ContextWindow, EmbeddingProvider } from '../memory/manager.js';
import type { Tool, ToolHandler } from '../tools/manager.js';
import type { JournalEntry } from '../journal/manager.js';
import {
  shellToolSchema,
  createShellHandler,
  createTaskToolSchema,
  createTaskHandler,
  createToolToolSchema,
  createCreateToolHandler,
  loadDynamicTools,
  discoverToolsSchema,
  createDiscoverToolsHandler,
  discoverSkillsSchema,
  createDiscoverSkillsHandler,
  readSkillSchema,
  createReadSkillHandler,
} from '../tools/handlers/index.js';

/** Shell confirmation event data */
export interface ShellConfirmEvent {
  command: string;
  cwd: string;
  resolve: (approved: boolean) => void;
}

/** Events emitted by the Agent */
export interface AgentEvents {
  'state:change': (state: AgentState, previousState: AgentState) => void;
  'memory:store': (memory: Memory) => void;
  'memory:decay': (count: number) => void;
  'journal:entry': (entry: JournalEntry) => void;
  'tool:invoke': (name: string, params: Record<string, unknown>, phase: 'start' | 'end', result?: unknown) => void;
  'run:start': (message: string) => void;
  'run:complete': (result: RunResult) => void;
  'run:iteration': (iteration: number, maxIterations: number) => void;
  'shell:confirm': (event: ShellConfirmEvent) => void;
  'thinking:start': () => void;
  'thinking:chunk': (chunk: string, accumulated: string) => void;
  'thinking:complete': (fullThought: string, tokensUsed: number) => void;
  'error': (error: Error) => void;
}

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Streaming chunk from LLM */
export interface StreamChunk {
  type: 'chunk' | 'tool_call' | 'done';
  content?: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
  tokensUsed?: number;
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

  /** Generate a streaming completion (optional) */
  completeStream?(messages: Message[], options?: {
    temperature?: number;
    maxTokens?: number;
    tools?: Tool[];
  }): AsyncGenerator<StreamChunk>;
}

export interface AgentOptions {
  /** LLM provider for completions */
  llm: LLMProvider;
  /** Embedding provider for vector search (optional - text search used if not provided) */
  embedder?: EmbeddingProvider;
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

export class Agent extends EventEmitter {
  private instance: KronkInstance;
  private llm: LLMProvider;
  private embedder?: EmbeddingProvider;
  private maxIterations: number;
  private autoJournal: boolean;
  private systemPromptAdditions: string;
  private state: AgentState = 'idle';
  private startTime: number = Date.now();

  constructor(instance: KronkInstance, options: AgentOptions) {
    super();
    this.instance = instance;
    this.llm = options.llm;
    this.embedder = options.embedder;
    this.maxIterations = options.maxIterations ?? 10;
    this.autoJournal = options.autoJournal ?? true;
    this.systemPromptAdditions = options.systemPromptAdditions ?? '';

    // Connect embedder to managers if provided
    if (this.embedder) {
      this.instance.memory.setEmbedder(this.embedder);
      this.instance.journal.setEmbedder(this.embedder);
    }
  }

  /**
   * Initialize the agent, registering core tools and loading dynamic tools.
   * Must be called after construction before using the agent.
   */
  async initialize(): Promise<void> {
    await this.registerCoreTools();
    const dynamicCount = await loadDynamicTools(this.instance.tools, this);
    if (dynamicCount > 0) {
      console.log(`[Kronk] Loaded ${dynamicCount} dynamic tool(s)`);
    }
  }

  /**
   * Register built-in core tools (shell, create_task, create_tool, discover_tools, skills)
   */
  private async registerCoreTools(): Promise<void> {
    // Register shell tool
    await this.instance.tools.register({
      name: 'shell',
      description: 'Execute shell commands and return stdout/stderr/exit code. Requires user confirmation.',
      schema: shellToolSchema,
      handler: 'core:shell',
      priority: 10,
      metadata: { category: 'shell' },
    });
    this.instance.tools.registerHandler(
      'shell',
      createShellHandler(this, this.instance.paths.root)
    );

    // Register create_task tool
    await this.instance.tools.register({
      name: 'create_task',
      description: 'Add a task to the background queue for async processing by the daemon.',
      schema: createTaskToolSchema,
      handler: 'core:create_task',
      priority: 10,
      metadata: { category: 'meta' },
    });
    this.instance.tools.registerHandler(
      'create_task',
      createTaskHandler(this.instance.db)
    );

    // Register create_tool tool
    await this.instance.tools.register({
      name: 'create_tool',
      description: 'Dynamically create new tools at runtime with shell, HTTP, or JavaScript handlers.',
      schema: createToolToolSchema,
      handler: 'core:create_tool',
      priority: 10,
      metadata: { category: 'meta' },
    });
    this.instance.tools.registerHandler(
      'create_tool',
      createCreateToolHandler(this.instance.tools, this)
    );

    // Register discover_tools tool
    await this.instance.tools.register({
      name: 'discover_tools',
      description: 'Search and list available tools. Use to find tools for specific tasks.',
      schema: discoverToolsSchema,
      handler: 'core:discover_tools',
      priority: 10,
      metadata: { category: 'meta' },
    });
    this.instance.tools.registerHandler(
      'discover_tools',
      createDiscoverToolsHandler(this.instance.tools)
    );

    // Register discover_skills tool
    await this.instance.tools.register({
      name: 'discover_skills',
      description: 'List available skill documentation. Skills describe domain-specific capabilities and commands.',
      schema: discoverSkillsSchema,
      handler: 'core:discover_skills',
      priority: 10,
      metadata: { category: 'meta' },
    });
    this.instance.tools.registerHandler(
      'discover_skills',
      createDiscoverSkillsHandler(this.instance.paths.skills)
    );

    // Register read_skill tool
    await this.instance.tools.register({
      name: 'read_skill',
      description: 'Read a specific skill documentation file to learn about available commands and capabilities.',
      schema: readSkillSchema,
      handler: 'core:read_skill',
      priority: 10,
      metadata: { category: 'meta' },
    });
    this.instance.tools.registerHandler(
      'read_skill',
      createReadSkillHandler(this.instance.paths.skills)
    );
  }

  /**
   * Type-safe event emitter methods
   */
  override on<K extends keyof AgentEvents>(event: K, listener: AgentEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof AgentEvents>(event: K, ...args: Parameters<AgentEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Get the uptime in milliseconds
   */
  getUptime(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Get the underlying KronkInstance
   */
  getInstance(): KronkInstance {
    return this.instance;
  }

  /**
   * Set the agent state and emit change event
   */
  private setState(newState: AgentState): void {
    const previousState = this.state;
    this.state = newState;
    if (previousState !== newState) {
      this.emit('state:change', newState, previousState);
    }
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

    this.emit('run:start', userMessage);

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
        this.emit('journal:entry', entry);
      }

      // Build context
      const context = await this.instance.memory.buildContextWindow();
      const tools = await this.instance.tools.listEnabled();

      // Run agent loop
      const messages: Message[] = [
        { role: 'system', content: await this.buildSystemPrompt(context, tools) },
        { role: 'user', content: userMessage },
      ];

      while (result.iterations < this.maxIterations) {
        result.iterations++;
        this.setState('thinking');
        this.emit('run:iteration', result.iterations, this.maxIterations);

        // Get LLM response (with streaming if available)
        const completion = await this.getCompletion(messages, tools);
        result.tokensUsed += completion.tokensUsed;

        // Log thought
        if (this.autoJournal) {
          const entry = await this.instance.journal.thought(
            `Iteration ${result.iterations}: ${completion.content.slice(0, 500)}`,
            { tokensUsed: completion.tokensUsed }
          );
          result.journalEntries.push(entry);
          this.emit('journal:entry', entry);
        }

        // Handle tool calls
        if (completion.toolCalls && completion.toolCalls.length > 0) {
          this.setState('acting');

          for (const toolCall of completion.toolCalls) {
            this.emit('tool:invoke', toolCall.name, toolCall.arguments, 'start');
            const startTime = Date.now();
            const toolResult = await this.instance.tools.invoke(
              toolCall.name,
              toolCall.arguments
            );
            const duration = Date.now() - startTime;
            this.emit('tool:invoke', toolCall.name, toolCall.arguments, 'end', toolResult);

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
              this.emit('journal:entry', entry);
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
        this.setState('observing');
        const memory = await this.instance.memory.store({
          tier: 'system1',
          content: `User: ${userMessage}\nAssistant: ${completion.content}`,
          summary: `Conversation about: ${userMessage.slice(0, 100)}`,
          source: 'agent',
          tags: ['conversation'],
        });
        result.memoriesCreated.push(memory);
        this.emit('memory:store', memory);

        break;
      }

      // Check if we hit max iterations
      if (!result.success) {
        result.error = `Reached maximum iterations (${this.maxIterations})`;
        if (this.autoJournal) {
          const entry = await this.instance.journal.error(result.error);
          this.emit('journal:entry', entry);
        }
      }

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      result.error = err.message;
      this.emit('error', err);
      if (this.autoJournal) {
        const entry = await this.instance.journal.error(`Agent error: ${result.error}`);
        this.emit('journal:entry', entry);
      }
    } finally {
      this.setState('idle');
      this.emit('run:complete', result);
    }

    return result;
  }

  /**
   * Get completion from LLM, using streaming if available
   */
  private async getCompletion(
    messages: Message[],
    tools: Tool[]
  ): Promise<{
    content: string;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
    tokensUsed: number;
  }> {
    // Use streaming if available
    if (this.llm.completeStream) {
      this.emit('thinking:start');
      let accumulated = '';
      const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
      let tokensUsed = 0;

      for await (const chunk of this.llm.completeStream(messages, { tools })) {
        if (chunk.type === 'chunk' && chunk.content) {
          accumulated += chunk.content;
          this.emit('thinking:chunk', chunk.content, accumulated);
        } else if (chunk.type === 'tool_call' && chunk.toolCall) {
          toolCalls.push(chunk.toolCall);
        } else if (chunk.type === 'done') {
          tokensUsed = chunk.tokensUsed ?? 0;
        }
      }

      this.emit('thinking:complete', accumulated, tokensUsed);

      return {
        content: accumulated,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        tokensUsed,
      };
    }

    // Fall back to non-streaming
    this.emit('thinking:start');
    const completion = await this.llm.complete(messages, { tools });
    this.emit('thinking:complete', completion.content, completion.tokensUsed);
    return completion;
  }

  /**
   * Add a memory to the agent
   */
  async remember(content: string, options: {
    tier?: 'system2' | 'working' | 'system1';
    tags?: string[];
    importance?: number;
  } = {}): Promise<Memory> {
    const memory = await this.instance.memory.store({
      tier: options.tier ?? 'working',
      content,
      tags: options.tags,
      importance: options.importance,
      source: 'user',
    });
    this.emit('memory:store', memory);
    return memory;
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
    this.setState('reflecting');
    try {
      await this.instance.memory.consolidate('system1', summarizer);
      await this.instance.memory.consolidate('working', summarizer);
      await this.instance.memory.consolidate('system2', summarizer);
    } finally {
      this.setState('idle');
    }
  }

  /**
   * Apply memory decay
   */
  async decayMemories(): Promise<number> {
    const count = await this.instance.memory.applyDecay();
    this.emit('memory:decay', count);
    return count;
  }

  /**
   * Get agent statistics
   */
  async getStats(): Promise<{
    memory: {
      system2: { count: number; avgImportance: number; totalTokens: number };
      working: { count: number; avgImportance: number; totalTokens: number };
      system1: { count: number; avgImportance: number; totalTokens: number };
    };
    journal: {
      totalEntries: number;
      byType: Record<string, number>;
      totalTokens: number;
      totalDuration: number;
    };
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
    this.setState('reflecting');
    try {
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
      this.emit('journal:entry', reflection);

      // Store reflection in working memory
      const memory = await this.instance.memory.store({
        tier: 'working',
        content: completion.content,
        summary: 'Recent self-reflection and insights',
        source: 'inference',
        tags: ['reflection', 'meta'],
        importance: 0.7,
      });
      this.emit('memory:store', memory);

      return reflection;
    } finally {
      this.setState('idle');
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
