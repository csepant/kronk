/**
 * Kronk - Agentic AI Framework
 *
 * A TypeScript framework for building autonomous AI agents with:
 * - Tiered memory (System 2 / Working / System 1)
 * - Vector search via TursoDB
 * - Tool registration and invocation
 * - Journaling and reflection
 * - Background daemon with IPC
 * - Interactive TUI dashboard
 * - Task queue and scheduling
 * - File system watchers
 *
 * @example
 * ```typescript
 * import { init, Agent, OpenAIEmbedder } from 'kronk';
 *
 * // Initialize agent
 * const instance = await init();
 *
 * // Create embedder
 * const embedder = new OpenAIEmbedder({ apiKey: process.env.OPENAI_API_KEY });
 *
 * // Create agent
 * const agent = new Agent(instance, {
 *   llm: myLLMProvider,
 *   embedder,
 * });
 *
 * // Run
 * const result = await agent.run('Help me plan a project');
 * console.log(result.response);
 * ```
 */

// Database
export { KronkDatabase, createLocalDb, createTursoDb, createEmbeddedReplicaDb } from './db/client.js';
export { SCHEMA_SQL, SCHEMA_VERSION, MEMORY_TIERS, VECTOR_DIMENSIONS, DEFAULT_CONSTITUTION } from './db/schema.js';
export type { KronkDbConfig } from './db/client.js';
export type { MemoryTier } from './db/schema.js';

// Memory
export { MemoryManager } from './memory/manager.js';
export type { Memory, MemoryInput, ContextWindow, EmbeddingProvider } from './memory/manager.js';

// Tools
export { ToolsManager } from './tools/manager.js';
export type { Tool, ToolInput, ToolSchema, ToolHandler } from './tools/manager.js';

// Journal
export { JournalManager } from './journal/manager.js';
export type { JournalEntry, JournalInput, JournalEntryType, JournalSearchResult } from './journal/manager.js';

// Initialization
export {
  init,
  load,
  getStatus,
  loadConstitution,
  updateConstitution,
  updateConfig,
  isInitialized,
  getKronkPath,
  getGlobalKronkPath,
} from './init/index.js';
export type { KronkConfig, KronkInstance } from './init/index.js';

// Core Agent
export { Agent } from './core/agent.js';
export type { AgentOptions, AgentState, AgentEvents, RunResult, Message, LLMProvider } from './core/agent.js';

// Embedders
export { OpenAIEmbedder, VoyageEmbedder, OllamaEmbedder, MockEmbedder } from './core/embedders.js';

// LLM Providers
export { OllamaLLM, OpenAILLM, AnthropicLLM, MockLLM } from './core/llm.js';

// Scheduler
export { Scheduler } from './core/scheduler.js';
export type { ScheduledTask, SchedulerConfig, SchedulerEvents } from './core/scheduler.js';

// Queue
export { QueueManager } from './queue/manager.js';
export type {
  QueueTask,
  QueueTaskInput,
  QueueManagerConfig,
  QueueEvents,
  TaskStatus,
  TaskHandler,
} from './queue/manager.js';

// Daemon
export { Daemon, startDaemonProcess, stopDaemon, getDaemonStatus } from './daemon/index.js';
export type { DaemonConfig, DaemonStatus, DaemonEvents } from './daemon/index.js';

// IPC
export { IPCServer } from './daemon/ipc.js';
export { IPCClient, connectToDaemon, isDaemonRunning } from './daemon/client.js';
export type { IPCServerConfig, IPCServerEvents, JsonRpcRequest, JsonRpcResponse } from './daemon/ipc.js';
export type { IPCClientConfig, IPCClientEvents } from './daemon/client.js';

// File Watcher
export { FileWatcher } from './watchers/file.js';
export type {
  Watcher,
  WatcherInput,
  WatcherAction,
  WatcherActionConfig,
  WatcherEventType,
  FileWatcherConfig,
  FileWatcherEvents,
} from './watchers/file.js';

// UI Components (for custom integrations)
export { App } from './ui/App.js';
export type { AppProps, ViewMode } from './ui/App.js';
export { Dashboard } from './ui/components/Dashboard.js';
export type { DashboardProps, MemoryStats, QueueStats } from './ui/components/Dashboard.js';
export { Chat } from './ui/components/Chat.js';
export type { ChatProps } from './ui/components/Chat.js';
export { Journal as JournalView } from './ui/components/Journal.js';
export type { JournalProps } from './ui/components/Journal.js';
export { Memory as MemoryView } from './ui/components/Memory.js';
export type { MemoryProps } from './ui/components/Memory.js';
export { TaskQueue } from './ui/components/TaskQueue.js';
export type { TaskQueueProps } from './ui/components/TaskQueue.js';

// UI Hooks
export { useAgent } from './ui/hooks/useAgent.js';
export type { UseAgentState } from './ui/hooks/useAgent.js';
