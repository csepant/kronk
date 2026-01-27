# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
bun run build      # Compile TypeScript (tsc)
bun run dev        # Watch mode compilation
bun test           # Run tests with Bun
bun run lint       # ESLint on src/
bun run kronk      # Run CLI directly (bun run src/cli.ts)
```

## Architecture Overview

Kronk is an agentic AI framework built on TypeScript with TursoDB (libSQL). It provides autonomous AI agents with persistent memory, tool integration, self-reflection, and background task processing.

### Core Components

**Agent** (`src/core/agent.ts`) - Main orchestrator managing the agentic loop:
- State machine: `idle → thinking → acting → observing → reflecting → idle`
- Coordinates memory, journal, tools, and LLM interactions
- Event-driven architecture extending EventEmitter

**Memory Manager** (`src/memory/manager.ts`) - 3-tiered cognitive memory system:
| Tier | Purpose | Max Tokens | Decay Rate |
|------|---------|------------|------------|
| `system2` | Long-horizon strategic | 4,000 | 0.01 (slow) |
| `working` | Current task context | 8,000 | 0.1 (moderate) |
| `system1` | Short-term reactive | 4,000 | 0.5 (fast) |

**Journal Manager** (`src/journal/manager.ts`) - Chronological logging with entry types: thought, action, observation, reflection, decision, error, milestone

**Tools Manager** (`src/tools/manager.ts`) - Dynamic tool registration with JSON Schema validation and runtime handler dispatch

### Background Services

- **Scheduler** (`src/core/scheduler.ts`) - Cron-based tasks (memory decay, cleanup, consolidation)
- **Queue Manager** (`src/queue/manager.ts`) - Persistent task queue with retry/backoff
- **Daemon** (`src/daemon/`) - Background process with IPC (JSON-RPC 2.0 over Unix sockets)
- **File Watcher** (`src/watchers/file.ts`) - Directory monitoring triggering agent actions

### LLM & Embedding Providers

LLM providers in `src/core/llm.ts`: OpenAI, Anthropic Claude, Ollama (local), Mock (testing)

Embedders return 1536-dim vectors: OpenAIEmbedder, VoyageEmbedder, OllamaEmbedder, MockEmbedder

### UI

React-based TUI using Ink framework (`src/ui/`). Views: dashboard, chat, journal, memory, tasks

### Database

TursoDB/libSQL with tables: memory (F32_BLOB embeddings), journal, tools, sessions, queue

Project directory structure stored in `.kronk/` (db, config, constitution, socket, pid)

## Key Patterns

1. **Event-Driven**: All major components extend EventEmitter with typed events
2. **Manager Pattern**: Centralized resource management (MemoryManager, ToolsManager, JournalManager, QueueManager)
3. **Embedding-First**: All semantic data supports optional vector embeddings with pluggable providers
4. **Persistence-First**: Everything persists to database (tools, memory, journal, queue, watchers)
5. **Type Safety**: Strict TypeScript, Zod validation, interface-driven design
