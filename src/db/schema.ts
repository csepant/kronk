/**
 * Kronk Database Schema
 * 
 * TursoDB (libSQL) schema with vector embeddings for semantic search.
 * Memory is organized into three cognitive tiers:
 * - System 2: Long-horizon strategic memory (goals, principles, learned patterns)
 * - Working: Current task context and active focus
 * - System 1: Short-term reactive memory (recent interactions, immediate context)
 */

export const SCHEMA_VERSION = 1;

export const VECTOR_DIMENSIONS = 1536; // OpenAI ada-002 / text-embedding-3-small

/**
 * SQL statements for initializing the Kronk database
 */
export const SCHEMA_SQL = `
-- Enable vector extension for semantic search
-- Note: TursoDB natively supports F32_BLOB for vectors

-- ============================================================================
-- TOOLS TABLE
-- Stores available tools/functions the agent can invoke
-- ============================================================================
CREATE TABLE IF NOT EXISTS tools (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    schema TEXT NOT NULL,  -- JSON Schema for parameters
    handler TEXT NOT NULL, -- Module path or function reference
    enabled INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 0,
    metadata TEXT,         -- JSON blob for additional config
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tools_enabled ON tools(enabled);
CREATE INDEX IF NOT EXISTS idx_tools_name ON tools(name);

-- ============================================================================
-- MEMORY TABLE
-- Tiered memory system with vector embeddings for semantic retrieval
-- ============================================================================
CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    
    -- Memory tier classification
    tier TEXT NOT NULL CHECK(tier IN ('system2', 'working', 'system1')),
    
    -- Content
    content TEXT NOT NULL,
    summary TEXT,              -- Compressed version for context efficiency
    
    -- Vector embedding for semantic search (1536 dims for OpenAI embeddings)
    embedding F32_BLOB(${VECTOR_DIMENSIONS}),
    
    -- Memory metadata
    importance REAL DEFAULT 0.5,    -- 0.0 to 1.0 relevance score
    access_count INTEGER DEFAULT 0,
    decay_rate REAL DEFAULT 0.1,    -- How fast memory fades (lower = stickier)
    
    -- Associations and context
    source TEXT,                    -- Origin: 'user', 'agent', 'tool', 'inference'
    tags TEXT,                      -- JSON array of tags
    related_ids TEXT,               -- JSON array of related memory IDs
    
    -- Timestamps
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    last_accessed_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT                 -- Optional TTL for ephemeral memories
);

CREATE INDEX IF NOT EXISTS idx_memory_tier ON memory(tier);
CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory(expires_at);

-- Vector index for semantic search on memory embeddings
CREATE INDEX IF NOT EXISTS idx_memory_embedding ON memory(
    libsql_vector_idx(embedding)
);

-- ============================================================================
-- JOURNAL TABLE
-- Chronological log of agent actions, thoughts, and observations
-- ============================================================================
CREATE TABLE IF NOT EXISTS journal (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    
    -- Entry classification
    entry_type TEXT NOT NULL CHECK(entry_type IN (
        'thought',      -- Internal reasoning
        'action',       -- Tool invocation or external action
        'observation',  -- Sensory input or tool results
        'reflection',   -- Meta-cognitive analysis
        'decision',     -- Choice points and rationale
        'error',        -- Failures and recovery attempts
        'milestone'     -- Significant achievements or state changes
    )),
    
    -- Content
    content TEXT NOT NULL,
    
    -- Vector embedding for semantic search
    embedding F32_BLOB(${VECTOR_DIMENSIONS}),
    
    -- Context links
    session_id TEXT,            -- Groups entries within a session
    parent_id TEXT,             -- For threaded/nested entries
    tool_id TEXT,               -- Reference to tool if action
    memory_ids TEXT,            -- JSON array of associated memories
    
    -- Execution context
    input TEXT,                 -- Input that triggered this entry
    output TEXT,                -- Result or response
    duration_ms INTEGER,        -- Execution time if applicable
    tokens_used INTEGER,        -- LLM token consumption
    
    -- Metadata
    confidence REAL,            -- Agent's confidence in this entry
    metadata TEXT,              -- Additional JSON metadata
    
    -- Timestamps
    created_at TEXT DEFAULT (datetime('now')),
    
    -- Foreign keys
    FOREIGN KEY (tool_id) REFERENCES tools(id),
    FOREIGN KEY (parent_id) REFERENCES journal(id)
);

CREATE INDEX IF NOT EXISTS idx_journal_type ON journal(entry_type);
CREATE INDEX IF NOT EXISTS idx_journal_session ON journal(session_id);
CREATE INDEX IF NOT EXISTS idx_journal_created ON journal(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_journal_parent ON journal(parent_id);

-- Vector index for semantic search on journal embeddings
CREATE INDEX IF NOT EXISTS idx_journal_embedding ON journal(
    libsql_vector_idx(embedding)
);

-- ============================================================================
-- SESSIONS TABLE
-- Tracks agent execution sessions
-- ============================================================================
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'failed')),
    goal TEXT,                  -- Primary objective for this session
    context TEXT,               -- JSON blob of session context
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT,
    metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

-- ============================================================================
-- MEMORY CONSOLIDATION VIEW
-- Helpful view for memory management operations
-- ============================================================================
CREATE VIEW IF NOT EXISTS memory_stats AS
SELECT 
    tier,
    COUNT(*) as count,
    AVG(importance) as avg_importance,
    SUM(access_count) as total_accesses,
    MIN(created_at) as oldest,
    MAX(created_at) as newest
FROM memory
GROUP BY tier;

-- ============================================================================
-- SCHEMA METADATA
-- ============================================================================
CREATE TABLE IF NOT EXISTS _kronk_meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

INSERT OR REPLACE INTO _kronk_meta (key, value) 
VALUES ('schema_version', '${SCHEMA_VERSION}');
`;

/**
 * Memory tier constraints and configuration
 */
export const MEMORY_TIERS = {
  system2: {
    name: 'System 2 / Long Horizon',
    description: 'Strategic memory: goals, principles, learned patterns, and identity',
    maxTokens: 4000,
    decayRate: 0.01,    // Very slow decay
    defaultImportance: 0.8,
    consolidationThreshold: 100, // Entries before consolidation
  },
  working: {
    name: 'Working Memory / Current Tasks',
    description: 'Active context: current objectives, in-progress work, relevant facts',
    maxTokens: 8000,
    decayRate: 0.1,     // Moderate decay
    defaultImportance: 0.6,
    consolidationThreshold: 50,
  },
  system1: {
    name: 'System 1 / Short Term',
    description: 'Reactive memory: recent interactions, immediate context, quick responses',
    maxTokens: 4000,
    decayRate: 0.5,     // Fast decay
    defaultImportance: 0.3,
    consolidationThreshold: 20,
  },
} as const;

export type MemoryTier = keyof typeof MEMORY_TIERS;

/**
 * Default constitution template for new agents
 */
export const DEFAULT_CONSTITUTION = `# Kronk Agent Constitution

## Identity

I am an autonomous agent powered by the Kronk framework. My purpose is to assist, learn, and act with integrity.

## Core Principles

### 1. Honesty & Transparency
- I communicate truthfully about my capabilities and limitations
- I acknowledge uncertainty rather than fabricating information
- I explain my reasoning when asked

### 2. Helpfulness
- I prioritize the user's genuine needs over literal requests
- I proactively offer relevant information and alternatives
- I learn from interactions to improve future assistance

### 3. Safety & Boundaries
- I refuse requests that could cause harm
- I protect user privacy and confidential information
- I escalate to humans when situations exceed my competence

### 4. Continuous Learning
- I maintain memories to provide consistent, personalized assistance
- I reflect on my actions to identify improvements
- I consolidate knowledge to stay within cognitive limits

## Memory Guidelines

### System 2 (Long Horizon)
Store here: Core goals, user preferences, learned principles, project context, identity-defining information.

### Working Memory
Store here: Current task state, active conversations, recent decisions, relevant context for ongoing work.

### System 1 (Short Term)  
Store here: Immediate interaction history, quick facts, temporary context that may not persist.

## Tool Usage

- Verify tool availability before attempting invocation
- Log all tool calls with rationale in the journal
- Handle failures gracefully with retry logic or alternatives

## Reflection Practices

- After significant actions, record observations and learnings
- Periodically review and consolidate memories
- Update this constitution as my understanding evolves

---

*Last updated: ${new Date().toISOString()}*
*Kronk Framework v${SCHEMA_VERSION}*
`;
