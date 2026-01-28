/**
 * Kronk Agent Core
 *
 * The main agent class that orchestrates memory, tools, journal,
 * and LLM interactions for autonomous operation.
 */

import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { KronkInstance, KronkConfig } from '../init/index.js';
import type { Memory, ContextWindow, EmbeddingProvider, SummarizerFunction } from '../memory/manager.js';
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
  journalToolSchema,
  createJournalHandler,
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

/** Tool call information with ID for multi-turn conversations */
export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Tool calls made by the assistant */
  tool_calls?: ToolCallInfo[];
  /** Tool call ID for tool result messages */
  tool_call_id?: string;
}

/** Streaming chunk from LLM */
export interface StreamChunk {
  type: 'chunk' | 'tool_call' | 'done';
  content?: string;
  toolCall?: { id?: string; name: string; arguments: Record<string, unknown> };
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
      id?: string;
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

/** Raw LLM response data for debugging */
export interface RawLlmResponse {
  /** Accumulated text chunks */
  chunks: string[];
  /** Tool calls received */
  toolCalls: Array<{ id?: string; name: string; arguments: Record<string, unknown> }>;
  /** Total tokens used */
  tokensUsed: number;
  /** Timestamp when response started */
  startedAt: Date;
  /** Timestamp when response completed */
  completedAt: Date;
}

export interface RunResult {
  success: boolean;
  response: string;
  iterations: number;
  tokensUsed: number;
  journalEntries: JournalEntry[];
  memoriesCreated: Memory[];
  error?: string;
  /** Raw LLM responses for each iteration (debug mode) */
  rawLlmResponses?: RawLlmResponse[];
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
    this.autoJournal = options.autoJournal ?? false;
    this.systemPromptAdditions = options.systemPromptAdditions ?? '';

    // Connect embedder to managers if provided
    if (this.embedder) {
      this.instance.memory.setEmbedder(this.embedder);
      this.instance.journal.setEmbedder(this.embedder);
    }

    // Set up the summarizer for dynamic memory management
    this.instance.memory.setSummarizer(this.createSummarizer());
  }

  /**
   * Create a summarizer function that uses the LLM
   */
  private createSummarizer(): SummarizerFunction {
    return async (content: string, targetTokens: number): Promise<string> => {
      const completion = await this.llm.complete([
        {
          role: 'system',
          content: `You are a summarization assistant. Summarize the following content concisely while preserving key information, decisions, and context. Target approximately ${targetTokens} tokens (about ${targetTokens * 4} characters). Focus on:
- Key decisions made
- Important information exchanged
- Current state and next steps
- Any unresolved questions or tasks`,
        },
        { role: 'user', content },
      ], { maxTokens: Math.max(targetTokens * 2, 500) });

      return completion.content;
    };
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

    // Register journal tool
    await this.instance.tools.register({
      name: 'journal',
      description: 'Log an entry to the journal. Use for recording decisions, reflections, milestones, errors, and noteworthy observations. Only log information worth remembering.',
      schema: journalToolSchema,
      handler: 'core:journal',
      priority: 10,
      metadata: { category: 'meta' },
    });
    this.instance.tools.registerHandler(
      'journal',
      createJournalHandler(this.instance.journal)
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
    const rawLlmResponses: RawLlmResponse[] = [];
    const result: RunResult = {
      success: false,
      response: '',
      iterations: 0,
      tokensUsed: 0,
      journalEntries: [],
      memoriesCreated: [],
      rawLlmResponses,
    };

    this.emit('run:start', userMessage);

    try {
      // Start session if not active
      if (!this.instance.journal.getSessionId()) {
        await this.instance.journal.startSession({
          goal: userMessage.slice(0, 200),
        });
      }

      // Build context
      const context = await this.instance.memory.buildContextWindow();
      const tools = await this.instance.tools.listEnabled();

      // Store user message in conversation history
      this.instance.memory.addConversationMessage('user', userMessage);

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
        rawLlmResponses.push(completion.rawResponse);

        // Handle tool calls
        if (completion.toolCalls && completion.toolCalls.length > 0) {
          this.setState('acting');

          // Add assistant message with all tool calls
          const toolCallsWithIds: ToolCallInfo[] = completion.toolCalls.map((tc, index) => ({
            id: tc.id ?? `tool_call_${Date.now()}_${index}`,
            name: tc.name,
            arguments: tc.arguments,
          }));

          messages.push({
            role: 'assistant',
            content: completion.content || null,
            tool_calls: toolCallsWithIds,
          });

          // Execute each tool and add result messages
          for (const toolCall of toolCallsWithIds) {
            this.emit('tool:invoke', toolCall.name, toolCall.arguments, 'start');
            const toolResult = await this.instance.tools.invoke(
              toolCall.name,
              toolCall.arguments
            );
            this.emit('tool:invoke', toolCall.name, toolCall.arguments, 'end', toolResult);

            const resultContent = JSON.stringify(toolResult.result ?? { error: toolResult.error });

            // Add tool result message with proper format
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: resultContent,
            });

            // Store tool result in conversation history
            this.instance.memory.addConversationMessage(
              'tool',
              `[${toolCall.name}] ${resultContent.slice(0, 500)}${resultContent.length > 500 ? '...' : ''}`,
              toolCall.id
            );
          }

          continue; // Get next LLM response with tool results
        }

        // No tool calls - this is the final response
        result.response = completion.content;
        result.success = true;

        // Store assistant response in conversation history
        this.instance.memory.addConversationMessage('assistant', completion.content);

        // Store interaction summary in short-term memory (for search/retrieval)
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

        // Auto-manage memory if needed (summarize if over threshold)
        await this.instance.memory.autoManage();

        break;
      }

      // Check if we hit max iterations
      if (!result.success) {
        result.error = `Reached maximum iterations (${this.maxIterations})`;
      }

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      result.error = err.message;
      this.emit('error', err);
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
    toolCalls?: Array<{ id?: string; name: string; arguments: Record<string, unknown> }>;
    tokensUsed: number;
    rawResponse: RawLlmResponse;
  }> {
    const startedAt = new Date();
    const chunks: string[] = [];

    // Use streaming if available
    if (this.llm.completeStream) {
      this.emit('thinking:start');
      let accumulated = '';
      const toolCalls: Array<{ id?: string; name: string; arguments: Record<string, unknown> }> = [];
      let tokensUsed = 0;

      for await (const chunk of this.llm.completeStream(messages, { tools })) {
        if (chunk.type === 'chunk' && chunk.content) {
          chunks.push(chunk.content);
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
        rawResponse: {
          chunks,
          toolCalls,
          tokensUsed,
          startedAt,
          completedAt: new Date(),
        },
      };
    }

    // Fall back to non-streaming
    this.emit('thinking:start');
    const completion = await this.llm.complete(messages, { tools });
    this.emit('thinking:complete', completion.content, completion.tokensUsed);

    // For non-streaming, the entire response is one "chunk"
    chunks.push(completion.content);

    return {
      ...completion,
      rawResponse: {
        chunks,
        toolCalls: completion.toolCalls ?? [],
        tokensUsed: completion.tokensUsed,
        startedAt,
        completedAt: new Date(),
      },
    };
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
   * Get the current conversation history
   */
  getConversation(): { role: string; content: string; timestamp: Date }[] {
    return this.instance.memory.getConversation();
  }

  /**
   * Manually trigger memory summarization/resizing
   */
  async manageMemory(): Promise<{
    conversationSummarized: boolean;
    tiersResized: boolean;
    tiersSummarized: string[];
  }> {
    return this.instance.memory.autoManage();
  }

  /**
   * Get memory allocation status
   */
  async getMemoryAllocations(): Promise<{
    tier: string;
    currentTokens: number;
    maxTokens: number;
    usage: number;
    needsSummarization: boolean;
  }[]> {
    return this.instance.memory.getTierAllocations();
  }

  /**
   * Clear conversation history (start fresh while keeping persistent memories)
   */
  clearConversation(): void {
    this.instance.memory.clearConversation();
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
    // Load constitution directly from file
    let constitution = '';
    try {
      constitution = await readFile(this.instance.paths.constitution, 'utf-8');
    } catch {
      constitution = 'No constitution found.';
    }

    const memoryContext = this.instance.memory.formatContextForPrompt(context);
    const toolPrompt = await this.instance.tools.generateToolPrompt();

    return `# Agent: ${this.instance.config.name}

## Constitution
${constitution}

## Memory
${memoryContext}

## Available Tools
${toolPrompt}

## Instructions
- Use your memory to maintain context across interactions
- Use the journal tool sparingly for information worth remembering:
  - Decisions: Record important choices and their rationale
  - Reflections: Log insights and lessons learned
  - Milestones: Mark significant achievements
  - Errors: Document failures and what went wrong
- Do NOT journal routine conversation or every action
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
