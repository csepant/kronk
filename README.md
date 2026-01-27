# 🦾 Kronk

![Kronk Logo](./Kronk_.webp)

**An agentic AI framework with tiered memory architecture and vector search**

Kronk provides a foundation for building autonomous AI agents with persistent memory, tool integration, and self-reflection capabilities. Built on TursoDB (libSQL) with native vector search support.

## Features

- **Tiered Memory System**: Three cognitive layers inspired by dual-process theory
  - **System 2 (Long Horizon)**: Strategic memory for goals, principles, and learned patterns
  - **Working Memory**: Current task context and active focus
  - **System 1 (Short Term)**: Reactive memory for recent interactions
  
- **Vector Search**: Semantic retrieval across memory and journal using TursoDB's native vector support

- **Tool Framework**: Register, discover, and invoke tools with JSON Schema validation

- **Journal & Reflection**: Chronological logging of thoughts, actions, and observations with self-reflection capabilities

- **Local-First**: Agent state persists in a `.kronk/` folder with SQLite, optionally syncing to Turso cloud

## Installation

```bash
# Using npm
npm install kronk

# Using bun
bun add kronk
```

## Quick Start

### Initialize an Agent

```bash
# Create a new agent in the current directory
kronk init --name "my-agent"
```

This creates a `.kronk/` folder with:
```
.kronk/
├── kronk.db          # TursoDB database
├── constitution.md   # Agent principles and guidelines
└── config.json       # Runtime configuration
```

### Programmatic Usage

```typescript
import { init, load, Agent, OpenAIEmbedder } from 'kronk';

// Initialize a new agent
const instance = await init(undefined, {
  config: { name: 'my-agent' }
});

// Or load an existing one
const instance = await load();

// Create an embedding provider
const embedder = new OpenAIEmbedder({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Create the agent with your LLM provider
const agent = new Agent(instance, {
  llm: myLLMProvider, // Implement LLMProvider interface
  embedder,
});

// Run the agent
const result = await agent.run('Help me plan a software project');
console.log(result.response);
```

## Memory System

### Memory Tiers

| Tier | Purpose | Max Tokens | Decay Rate |
|------|---------|------------|------------|
| `system2` | Strategic, long-term knowledge | 4,000 | 0.01 (slow) |
| `working` | Current tasks and active context | 8,000 | 0.1 (moderate) |
| `system1` | Recent interactions and immediate context | 4,000 | 0.5 (fast) |

### Working with Memory

```typescript
// Store a memory
await instance.memory.store({
  tier: 'working',
  content: 'The user prefers TypeScript over JavaScript',
  importance: 0.8,
  source: 'inference',
  tags: ['preference', 'language'],
});

// Semantic search
const results = await instance.memory.search('programming language preferences', {
  limit: 5,
  minSimilarity: 0.6,
});

// Build context window for LLM
const context = await instance.memory.buildContextWindow();
const prompt = instance.memory.formatContextForPrompt(context);

// Promote important memories
await instance.memory.promote(memoryId); // system1 → working → system2

// Apply decay and cleanup
await instance.memory.applyDecay();
await instance.memory.cleanup();
```

## Tools

```typescript
// Register a tool
await instance.tools.register({
  name: 'web_search',
  description: 'Search the web for information',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results', default: 10 },
    },
    required: ['query'],
  },
  handler: 'runtime:web_search',
});

// Register runtime handler
instance.tools.registerHandler('web_search', async (params) => {
  const { query, limit } = params;
  // Implement search logic
  return { results: [...] };
});

// Invoke a tool
const result = await instance.tools.invoke('web_search', { query: 'TursoDB' });
```

## Journal

```typescript
// Start a session
const sessionId = await instance.journal.startSession({
  goal: 'Build a REST API',
});

// Log entries
await instance.journal.thought('Considering Express vs Fastify');
await instance.journal.decision('Choosing Fastify for performance', 0.85);
await instance.journal.action(
  'Created project scaffold',
  toolId,
  '{"template": "fastify"}',
  '{"success": true}',
  1234 // duration ms
);
await instance.journal.milestone('MVP API completed');

// Search journal
const entries = await instance.journal.search('API design decisions');

// Generate narrative
const narrative = await instance.journal.formatAsNarrative(20);

// End session
await instance.journal.endSession('completed');
```

## CLI Commands

```bash
# Initialize agent
kronk init --name my-agent --model claude-sonnet-4-20250514

# View status
kronk status

# Memory operations
kronk memory list --tier working --limit 10
kronk memory add "Important fact" --tier system2 --importance 0.9
kronk memory stats

# Journal operations
kronk journal list --type decision --limit 20

# Tool management
kronk tools list

# View constitution
kronk constitution

# Configuration
kronk config
kronk config --set debug=true
```

## Constitution

The `constitution.md` file defines your agent's identity and guidelines:

```markdown
# Agent Constitution

## Core Principles
1. Honesty & Transparency
2. Helpfulness
3. Safety & Boundaries
4. Continuous Learning

## Memory Guidelines
- System 2: Store core goals and learned patterns
- Working: Store current task context
- System 1: Store recent interactions

## Tool Usage
- Verify availability before invocation
- Log all tool calls with rationale
- Handle failures gracefully
```

## Database Schema

```sql
-- Memory with vector embeddings
CREATE TABLE memory (
    id TEXT PRIMARY KEY,
    tier TEXT CHECK(tier IN ('system2', 'working', 'system1')),
    content TEXT NOT NULL,
    embedding F32_BLOB(1536),
    importance REAL DEFAULT 0.5,
    decay_rate REAL DEFAULT 0.1,
    -- ...
);

-- Journal entries
CREATE TABLE journal (
    id TEXT PRIMARY KEY,
    entry_type TEXT CHECK(entry_type IN ('thought', 'action', 'observation', ...)),
    content TEXT NOT NULL,
    embedding F32_BLOB(1536),
    session_id TEXT,
    -- ...
);

-- Tools
CREATE TABLE tools (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE,
    description TEXT,
    schema TEXT, -- JSON Schema
    handler TEXT,
    enabled INTEGER DEFAULT 1,
    -- ...
);
```

## Embedding Providers

```typescript
// OpenAI
const embedder = new OpenAIEmbedder({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'text-embedding-3-small',
});

// Voyage AI
const embedder = new VoyageEmbedder({
  apiKey: process.env.VOYAGE_API_KEY,
  model: 'voyage-2',
});

// Local Ollama
const embedder = new OllamaEmbedder({
  model: 'nomic-embed-text',
  baseUrl: 'http://localhost:11434',
});

// Mock (for testing)
const embedder = new MockEmbedder();
```

## Cloud Sync with Turso

```typescript
import { createEmbeddedReplicaDb } from 'kronk';

// Local SQLite with sync to Turso cloud
const db = createEmbeddedReplicaDb(
  './kronk.db',
  'libsql://your-db.turso.io',
  'your-auth-token',
  60 // sync interval in seconds
);
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Agent                                │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    LLM Provider                          │ │
│  └─────────────────────────────────────────────────────────┘ │
│                            │                                  │
│  ┌─────────────┬───────────┼───────────┬──────────────────┐  │
│  │             │           │           │                  │  │
│  ▼             ▼           ▼           ▼                  │  │
│ ┌───────┐  ┌────────┐  ┌────────┐  ┌─────────┐           │  │
│ │Memory │  │ Tools  │  │Journal │  │Embedder │           │  │
│ │Manager│  │Manager │  │Manager │  │         │           │  │
│ └───┬───┘  └────┬───┘  └───┬────┘  └────┬────┘           │  │
│     │           │          │            │                 │  │
│     └───────────┴──────────┴────────────┘                 │  │
│                            │                               │  │
│  ┌─────────────────────────┴─────────────────────────────┐ │
│  │                   TursoDB (libSQL)                     │ │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐   │ │
│  │  │ Memory  │  │  Tools  │  │ Journal │  │Sessions │   │ │
│  │  │ (F32)   │  │         │  │  (F32)  │  │         │   │ │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘   │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## License

MIT

## Contributing

Contributions welcome! Please read CONTRIBUTING.md before submitting PRs.
