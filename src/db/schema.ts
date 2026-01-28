/**
 * Kronk Database Schema
 * 
 * TursoDB (libSQL) schema with vector embeddings for semantic search.
 * Memory is organized into three cognitive tiers:
 * - System 2: Long-horizon strategic memory (goals, principles, learned patterns)
 * - Working: Current task context and active focus
 * - System 1: Short-term reactive memory (recent interactions, immediate context)
 */

export const SCHEMA_VERSION = 2;

export const VECTOR_DIMENSIONS = 1536; // OpenAI ada-002 / text-embedding-3-small

/**
 * SQL statements for initializing the Kronk database (with vector search)
 */
export const SCHEMA_SQL_VECTOR = `
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
    
    -- Memory tier classification (valid: 'system2', 'working', 'system1')
    tier TEXT NOT NULL,
    
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
    
    -- Entry classification (valid: 'thought', 'action', 'observation', 'reflection', 'decision', 'error', 'milestone')
    entry_type TEXT NOT NULL,
    
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
    status TEXT DEFAULT 'active',  -- valid: 'active', 'paused', 'completed', 'failed'
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
-- TASK QUEUE TABLE
-- Background task processing with priority and retry support
-- ============================================================================
CREATE TABLE IF NOT EXISTS task_queue (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    type TEXT NOT NULL,              -- Task type identifier
    payload TEXT,                    -- JSON payload for the task
    priority INTEGER DEFAULT 0,      -- Higher = more urgent
    status TEXT DEFAULT 'pending',  -- valid: 'pending', 'running', 'completed', 'failed', 'cancelled'
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    error TEXT,                      -- Error message if failed
    result TEXT,                     -- JSON result if completed
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status);
CREATE INDEX IF NOT EXISTS idx_task_queue_priority ON task_queue(priority DESC, created_at ASC);

-- ============================================================================
-- WATCHERS TABLE
-- File system watchers for triggering actions
-- ============================================================================
CREATE TABLE IF NOT EXISTS watchers (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    pattern TEXT NOT NULL,           -- Glob pattern to watch
    action TEXT NOT NULL,            -- Action type: 'run', 'memory', 'tool'
    action_config TEXT,              -- JSON config for the action
    enabled INTEGER DEFAULT 1,
    debounce_ms INTEGER DEFAULT 500,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_watchers_enabled ON watchers(enabled);

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
 * SQL statements for initializing the Kronk database (text-only, no vectors)
 */
export const SCHEMA_SQL_TEXT = `
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
-- Tiered memory system (text-only, no embeddings)
-- ============================================================================
CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),

    -- Memory tier classification (valid: 'system2', 'working', 'system1')
    tier TEXT NOT NULL,

    -- Content
    content TEXT NOT NULL,
    summary TEXT,              -- Compressed version for context efficiency

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

-- Full-text search index for text-based search
CREATE INDEX IF NOT EXISTS idx_memory_content ON memory(content);

-- ============================================================================
-- JOURNAL TABLE
-- Chronological log of agent actions, thoughts, and observations
-- ============================================================================
CREATE TABLE IF NOT EXISTS journal (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),

    -- Entry classification (valid: 'thought', 'action', 'observation', 'reflection', 'decision', 'error', 'milestone')
    entry_type TEXT NOT NULL,

    -- Content
    content TEXT NOT NULL,

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

-- Full-text search index for text-based search
CREATE INDEX IF NOT EXISTS idx_journal_content ON journal(content);

-- ============================================================================
-- SESSIONS TABLE
-- Tracks agent execution sessions
-- ============================================================================
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT,
    status TEXT DEFAULT 'active',  -- valid: 'active', 'paused', 'completed', 'failed'
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
-- TASK QUEUE TABLE
-- Background task processing with priority and retry support
-- ============================================================================
CREATE TABLE IF NOT EXISTS task_queue (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    type TEXT NOT NULL,              -- Task type identifier
    payload TEXT,                    -- JSON payload for the task
    priority INTEGER DEFAULT 0,      -- Higher = more urgent
    status TEXT DEFAULT 'pending',  -- valid: 'pending', 'running', 'completed', 'failed', 'cancelled'
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    error TEXT,                      -- Error message if failed
    result TEXT,                     -- JSON result if completed
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status);
CREATE INDEX IF NOT EXISTS idx_task_queue_priority ON task_queue(priority DESC, created_at ASC);

-- ============================================================================
-- WATCHERS TABLE
-- File system watchers for triggering actions
-- ============================================================================
CREATE TABLE IF NOT EXISTS watchers (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    pattern TEXT NOT NULL,           -- Glob pattern to watch
    action TEXT NOT NULL,            -- Action type: 'run', 'memory', 'tool'
    action_config TEXT,              -- JSON config for the action
    enabled INTEGER DEFAULT 1,
    debounce_ms INTEGER DEFAULT 500,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_watchers_enabled ON watchers(enabled);

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
 * Get the appropriate schema SQL based on configuration
 */
export function getSchemaSQL(useVectorSearch: boolean): string {
  return useVectorSearch ? SCHEMA_SQL_VECTOR : SCHEMA_SQL_TEXT;
}

/**
 * Legacy alias for backwards compatibility
 * @deprecated Use getSchemaSQL(true) instead
 */
export const SCHEMA_SQL = SCHEMA_SQL_VECTOR;

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

// Re-export the comprehensive constitution from its dedicated module
export { DEFAULT_CONSTITUTION } from './constitution.js';
