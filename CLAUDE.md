# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
bun run build      # Compile TypeScript (tsc) to dist/
bun run dev        # Watch mode compilation
bun test           # Run all tests with Bun
bun test src/tools/handlers/__tests__/shell.test.ts  # Run a single test file
bun run lint       # ESLint on src/
bun run kronk      # Run CLI directly (bun run src/cli.ts)
```

Tests use `bun:test` (describe/test/expect). Test files live alongside source in `__tests__/` directories.

## Architecture Overview

Kronk is an agentic AI framework built on TypeScript with TursoDB (libSQL). It provides autonomous AI agents with persistent memory, tool integration, self-reflection, and background task processing.

### Init/Load Flow

`kronk init` (`src/init/index.ts`) creates `.kronk/` with db, config, constitution, and seeds default skills. `load()` reconnects to an existing `.kronk/` and initializes all managers. Both return a `KronkInstance` with all managers and path references.

```
.kronk/
├── kronk.db          # TursoDB/libSQL database
├── config.json       # Runtime configuration
├── constitution.md   # Agent identity and principles
├── skills/           # Skill docs (git.md, shell.md, file-management.md, npm.md)
├── kronk.sock        # Unix socket for daemon IPC (runtime)
└── kronk.pid         # Daemon PID file (runtime)
```

### Core Components

**Agent** (`src/core/agent.ts`) - Main orchestrator managing the agentic loop:
- State machine: `idle → thinking → acting → observing → reflecting → idle`
- Coordinates memory, journal, tools, and LLM interactions
- Emits typed events: `state:change`, `memory:store`, `journal:entry`, `tool:invoke`, `thinking:chunk`, `shell:confirm`, `notify`
- Registers 8 built-in tools on `initialize()` (see Built-in Tools below)

**Memory Manager** (`src/memory/manager.ts`) - 3-tiered cognitive memory system:
| Tier | Purpose | Default Max Tokens | Decay Rate |
|------|---------|-------------------|------------|
| `system2` | Long-horizon strategic | 30,000 | 0.01 (slow) |
| `working` | Current task context | 100,000 | 0.1 (moderate) |
| `system1` | Short-term reactive | 20,000 | 0.5 (fast) |

Auto-summarizes when tiers reach 80-90% capacity using an LLM-powered summarizer.

**Message Manager** (`src/messages/manager.ts`) - Chat message persistence with role, content, tool_calls, and session tracking.

**Journal Manager** (`src/journal/manager.ts`) - Chronological logging with entry types: thought, action, observation, reflection, decision, error, milestone

**Tools Manager** (`src/tools/manager.ts`) - Dynamic tool registration with JSON Schema validation. Tools use `handler` strings prefixed with `core:`, `runtime:`, or `dynamic:<type>:` to route invocations.

### Built-in Tools (registered in Agent.initialize)

| Tool | Handler | Purpose |
|------|---------|---------|
| `shell` | `core:shell` | Execute shell commands (emits `shell:confirm` for approval) |
| `create_task` | `core:create_task` | Add background queue task |
| `create_tool` | `core:create_tool` | Create tools at runtime (shell/http/javascript handlers) |
| `discover_tools` | `core:discover_tools` | Search/list available tools |
| `discover_skills` | `core:discover_skills` | List skill docs from `.kronk/skills/` |
| `read_skill` | `core:read_skill` | Read skill markdown content |
| `journal` | `core:journal` | Log journal entries from within agent |
| `notify` | `core:notify` | Send user notifications |

Dynamic tools created via `create_tool` are persisted to DB and reloaded on agent init via `loadDynamicTools()`.

### Background Services

- **Scheduler** (`src/core/scheduler.ts`) - Cron-based: memory decay (hourly), cleanup (hourly), consolidation (daily), proactive think (every 15 min)
- **Queue Manager** (`src/queue/manager.ts`) - Priority-based task queue with exponential backoff retry, max 3 concurrent tasks
- **Daemon** (`src/daemon/`) - Background process with JSON-RPC 2.0 IPC over Unix sockets. Integrates Agent, Scheduler, QueueManager, IPCServer, and optional WSServer
- **WebSocket Server** (`src/ws/server.ts`) - `Bun.serve()` WebSocket server for browser/remote clients. Reuses JSON-RPC 2.0 protocol, same methods as IPC plus `shell.confirm.respond` and thinking event streaming (`agent.thinking.start`, `agent.thinking.chunk`, `agent.thinking.complete`). Origin validation via `allowedOrigins`. Enabled with `--ws-port` flag on `kronk start`
- **File Watcher** (`src/watchers/file.ts`) - Chokidar-based directory monitoring. Actions: run, memory, queue, tool

### LLM & Embedding Providers

All LLM providers implement `LLMProvider` interface with `complete()` and optional `completeStream()`. Located in `src/core/llm.ts`: OllamaLLM, OpenAILLM, AnthropicLLM, MockLLM.

All embedders implement `EmbeddingProvider` with `embed()` returning 1536-dim vectors (`src/core/embedders.ts`): OpenAIEmbedder, VoyageEmbedder, OllamaEmbedder, MockEmbedder.

### Database

TursoDB/libSQL with two schema modes: `SCHEMA_SQL_VECTOR` (with F32_BLOB embeddings + vector indexes) and `SCHEMA_SQL_TEXT` (text-only fallback). Schema version tracked in `_kronk_meta` table (current: v3). Vector search controlled by `useVectorSearch` config flag.

Tables: memory, journal, tools, sessions, messages, task_queue, watchers. Database client helpers in `src/db/client.ts`: `createLocalDb`, `createTursoDb`, `createEmbeddedReplicaDb`.

### UI

React-based TUI using Ink framework (`src/ui/`). Views: dashboard, chat, journal, memory, tasks. `useAgent` hook in `src/ui/hooks/useAgent.ts` manages agent lifecycle.

### Public API

`src/index.ts` exports everything needed for programmatic usage: init/load functions, Agent, all managers, all LLM/embedder providers, Scheduler, QueueManager, Daemon, IPC, WSServer, FileWatcher, and UI components.

## Environment Variables

```bash
LLM_PROVIDER=anthropic|openai|ollama
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2
OLLAMA_EMBED_MODEL=nomic-embed-text
```

Provider can also be set via CLI flags: `kronk init --provider anthropic --model claude-sonnet-4-20250514`

### WebSocket Server

Start the daemon with a WebSocket interface for browser/remote clients:

```bash
kronk start --ws-port 3000                                          # Basic
kronk start --ws-port 3000 --ws-host 0.0.0.0 --ws-origins "http://localhost:5173"  # With CORS
```

Uses JSON-RPC 2.0 over WebSocket. Supports all IPC methods plus `shell.confirm.respond` for interactive shell approval and thinking event notifications. Config passed via `DaemonConfig.websocket`.

## Key Patterns

1. **Event-Driven**: All major components extend EventEmitter with typed events
2. **Manager Pattern**: Centralized resource management (MemoryManager, ToolsManager, JournalManager, QueueManager, MessageManager)
3. **Embedding-Optional**: Vector search can be disabled; schema adapts to text-only mode
4. **Persistence-First**: Everything persists to database (tools, memory, journal, queue, watchers, messages)
5. **Type Safety**: Strict TypeScript (ES2022 target), Zod validation for tool schemas, JSX via react-jsx
