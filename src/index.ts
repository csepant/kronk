/**
 * Kronk - Agentic AI Framework
 * 
 * A TypeScript framework for building autonomous AI agents with:
 * - Tiered memory (System 2 / Working / System 1)
 * - Vector search via TursoDB
 * - Tool registration and invocation
 * - Journaling and reflection
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
export type { AgentOptions, AgentState, RunResult, Message, LLMProvider } from './core/agent.js';

// Embedders
export { OpenAIEmbedder, VoyageEmbedder, OllamaEmbedder, MockEmbedder } from './core/embedders.js';
