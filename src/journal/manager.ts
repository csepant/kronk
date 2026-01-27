/**
 * Kronk Journal Manager
 * 
 * Chronological log of agent actions, thoughts, and observations.
 * Supports vector search for retrieving relevant past experiences.
 */

import type { KronkDatabase } from '../db/client.js';
import type { EmbeddingProvider } from '../memory/manager.js';

export type JournalEntryType =
  | 'thought'      // Internal reasoning
  | 'action'       // Tool invocation
  | 'observation'  // Sensory input or tool results
  | 'reflection'   // Meta-cognitive analysis
  | 'decision'     // Choice points
  | 'error'        // Failures
  | 'milestone';   // Significant achievements

export interface JournalEntry {
  id: string;
  entryType: JournalEntryType;
  content: string;
  sessionId?: string;
  parentId?: string;
  toolId?: string;
  memoryIds: string[];
  input?: string;
  output?: string;
  durationMs?: number;
  tokensUsed?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface JournalInput {
  entryType: JournalEntryType;
  content: string;
  sessionId?: string;
  parentId?: string;
  toolId?: string;
  memoryIds?: string[];
  input?: string;
  output?: string;
  durationMs?: number;
  tokensUsed?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface JournalSearchResult extends JournalEntry {
  similarity: number;
}

export class JournalManager {
  private db: KronkDatabase;
  private embedder?: EmbeddingProvider;
  private currentSessionId?: string;

  constructor(db: KronkDatabase, embedder?: EmbeddingProvider) {
    this.db = db;
    this.embedder = embedder;
  }

  /**
   * Set the embedding provider
   */
  setEmbedder(embedder: EmbeddingProvider): void {
    this.embedder = embedder;
  }

  /**
   * Start a new session
   */
  async startSession(options: {
    name?: string;
    goal?: string;
    context?: Record<string, unknown>;
  } = {}): Promise<string> {
    const sql = `
      INSERT INTO sessions (name, goal, context)
      VALUES (?, ?, ?)
      RETURNING id
    `;

    const result = await this.db.query(sql, [
      options.name ?? null,
      options.goal ?? null,
      options.context ? JSON.stringify(options.context) : null,
    ]);

    this.currentSessionId = result.rows[0]?.id as string;
    return this.currentSessionId;
  }

  /**
   * End the current session
   */
  async endSession(status: 'completed' | 'failed' = 'completed'): Promise<void> {
    if (!this.currentSessionId) return;

    await this.db.query(
      `UPDATE sessions SET status = ?, ended_at = datetime('now') WHERE id = ?`,
      [status, this.currentSessionId]
    );

    this.currentSessionId = undefined;
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | undefined {
    return this.currentSessionId;
  }

  /**
   * Set the current session ID (for resuming)
   */
  setSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  /**
   * Log a journal entry
   */
  async log(input: JournalInput): Promise<JournalEntry> {
    // Generate embedding if provider is available
    let embeddingBlob: string | null = null;
    if (this.embedder) {
      const embedding = await this.embedder.embed(input.content);
      embeddingBlob = `vector('[${embedding.join(',')}]')`;
    }

    const sql = `
      INSERT INTO journal (
        entry_type, content, embedding,
        session_id, parent_id, tool_id, memory_ids,
        input, output, duration_ms, tokens_used,
        confidence, metadata
      ) VALUES (
        ?, ?, ${embeddingBlob ?? 'NULL'},
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )
      RETURNING *
    `;

    const result = await this.db.query(sql, [
      input.entryType,
      input.content,
      input.sessionId ?? this.currentSessionId ?? null,
      input.parentId ?? null,
      input.toolId ?? null,
      JSON.stringify(input.memoryIds ?? []),
      input.input ?? null,
      input.output ?? null,
      input.durationMs ?? null,
      input.tokensUsed ?? null,
      input.confidence ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]);

    return this.rowToEntry(result.rows[0]);
  }

  /**
   * Shorthand for logging a thought
   */
  async thought(content: string, options: Partial<JournalInput> = {}): Promise<JournalEntry> {
    return this.log({ ...options, entryType: 'thought', content });
  }

  /**
   * Shorthand for logging an action
   */
  async action(
    content: string,
    toolId: string,
    input: string,
    output: string,
    durationMs: number,
    options: Partial<JournalInput> = {}
  ): Promise<JournalEntry> {
    return this.log({
      ...options,
      entryType: 'action',
      content,
      toolId,
      input,
      output,
      durationMs,
    });
  }

  /**
   * Shorthand for logging an observation
   */
  async observation(content: string, options: Partial<JournalInput> = {}): Promise<JournalEntry> {
    return this.log({ ...options, entryType: 'observation', content });
  }

  /**
   * Shorthand for logging a reflection
   */
  async reflection(content: string, options: Partial<JournalInput> = {}): Promise<JournalEntry> {
    return this.log({ ...options, entryType: 'reflection', content });
  }

  /**
   * Shorthand for logging a decision
   */
  async decision(content: string, confidence?: number, options: Partial<JournalInput> = {}): Promise<JournalEntry> {
    return this.log({ ...options, entryType: 'decision', content, confidence });
  }

  /**
   * Shorthand for logging an error
   */
  async error(content: string, options: Partial<JournalInput> = {}): Promise<JournalEntry> {
    return this.log({ ...options, entryType: 'error', content });
  }

  /**
   * Shorthand for logging a milestone
   */
  async milestone(content: string, options: Partial<JournalInput> = {}): Promise<JournalEntry> {
    return this.log({ ...options, entryType: 'milestone', content });
  }

  /**
   * Get a journal entry by ID
   */
  async get(id: string): Promise<JournalEntry | null> {
    const result = await this.db.query('SELECT * FROM journal WHERE id = ?', [id]);
    if (result.rows.length === 0) return null;
    return this.rowToEntry(result.rows[0]);
  }

  /**
   * Get recent journal entries
   */
  async getRecent(limit = 50, sessionId?: string): Promise<JournalEntry[]> {
    const whereClause = sessionId ? 'WHERE session_id = ?' : '';
    const args = sessionId ? [sessionId, limit] : [limit];

    const result = await this.db.query(
      `SELECT * FROM journal ${whereClause} ORDER BY created_at DESC LIMIT ?`,
      args
    );

    return result.rows.map(r => this.rowToEntry(r));
  }

  /**
   * Get entries by type
   */
  async getByType(entryType: JournalEntryType, limit = 50): Promise<JournalEntry[]> {
    const result = await this.db.query(
      'SELECT * FROM journal WHERE entry_type = ? ORDER BY created_at DESC LIMIT ?',
      [entryType, limit]
    );

    return result.rows.map(r => this.rowToEntry(r));
  }

  /**
   * Search journal entries by semantic similarity
   */
  async search(
    query: string,
    options: {
      entryType?: JournalEntryType;
      sessionId?: string;
      limit?: number;
      minSimilarity?: number;
    } = {}
  ): Promise<JournalSearchResult[]> {
    if (!this.embedder) {
      throw new Error('Embedding provider required for semantic search');
    }

    const embedding = await this.embedder.embed(query);

    const filters: string[] = [];
    const filterArgs: unknown[] = [];

    if (options.entryType) {
      filters.push('entry_type = ?');
      filterArgs.push(options.entryType);
    }

    if (options.sessionId) {
      filters.push('session_id = ?');
      filterArgs.push(options.sessionId);
    }

    const results = await this.db.vectorSearch('journal', embedding, {
      limit: options.limit ?? 10,
      minSimilarity: options.minSimilarity ?? 0.5,
      filter: filters.length > 0 ? filters.join(' AND ') : undefined,
      filterArgs: filterArgs.length > 0 ? filterArgs : undefined,
    });

    return results.map(row => ({
      ...this.rowToEntry(row),
      similarity: row.similarity,
    }));
  }

  /**
   * Get thread of entries (entry with its children)
   */
  async getThread(parentId: string): Promise<JournalEntry[]> {
    const result = await this.db.query(
      `WITH RECURSIVE thread AS (
        SELECT * FROM journal WHERE id = ?
        UNION ALL
        SELECT j.* FROM journal j
        JOIN thread t ON j.parent_id = t.id
      )
      SELECT * FROM thread ORDER BY created_at ASC`,
      [parentId]
    );

    return result.rows.map(r => this.rowToEntry(r));
  }

  /**
   * Get session statistics
   */
  async getSessionStats(sessionId?: string): Promise<{
    totalEntries: number;
    byType: Record<JournalEntryType, number>;
    totalDuration: number;
    totalTokens: number;
    avgConfidence: number;
  }> {
    const whereClause = sessionId ? 'WHERE session_id = ?' : '';
    const args = sessionId ? [sessionId] : [];

    const result = await this.db.query(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN entry_type = 'thought' THEN 1 ELSE 0 END) as thoughts,
        SUM(CASE WHEN entry_type = 'action' THEN 1 ELSE 0 END) as actions,
        SUM(CASE WHEN entry_type = 'observation' THEN 1 ELSE 0 END) as observations,
        SUM(CASE WHEN entry_type = 'reflection' THEN 1 ELSE 0 END) as reflections,
        SUM(CASE WHEN entry_type = 'decision' THEN 1 ELSE 0 END) as decisions,
        SUM(CASE WHEN entry_type = 'error' THEN 1 ELSE 0 END) as errors,
        SUM(CASE WHEN entry_type = 'milestone' THEN 1 ELSE 0 END) as milestones,
        COALESCE(SUM(duration_ms), 0) as total_duration,
        COALESCE(SUM(tokens_used), 0) as total_tokens,
        AVG(confidence) as avg_confidence
      FROM journal ${whereClause}`,
      args
    );

    const row = result.rows[0];
    return {
      totalEntries: row.total as number,
      byType: {
        thought: row.thoughts as number,
        action: row.actions as number,
        observation: row.observations as number,
        reflection: row.reflections as number,
        decision: row.decisions as number,
        error: row.errors as number,
        milestone: row.milestones as number,
      },
      totalDuration: row.total_duration as number,
      totalTokens: row.total_tokens as number,
      avgConfidence: (row.avg_confidence as number) ?? 0,
    };
  }

  /**
   * Format recent journal as narrative for LLM context
   */
  async formatAsNarrative(limit = 20, sessionId?: string): Promise<string> {
    const entries = await this.getRecent(limit, sessionId);
    if (entries.length === 0) return 'No journal entries yet.';

    const lines = ['# Recent Activity\n'];

    for (const entry of entries.reverse()) { // Chronological order
      const timestamp = entry.createdAt.toISOString().slice(0, 19).replace('T', ' ');
      const prefix = this.getEntryPrefix(entry.entryType);
      lines.push(`[${timestamp}] ${prefix} ${entry.content}`);
    }

    return lines.join('\n');
  }

  /**
   * Get emoji/prefix for entry type
   */
  private getEntryPrefix(type: JournalEntryType): string {
    const prefixes: Record<JournalEntryType, string> = {
      thought: '💭',
      action: '⚡',
      observation: '👁️',
      reflection: '🪞',
      decision: '⚖️',
      error: '❌',
      milestone: '🎯',
    };
    return prefixes[type];
  }

  /**
   * Convert database row to JournalEntry
   */
  private rowToEntry(row: Record<string, unknown>): JournalEntry {
    return {
      id: row.id as string,
      entryType: row.entry_type as JournalEntryType,
      content: row.content as string,
      sessionId: row.session_id as string | undefined,
      parentId: row.parent_id as string | undefined,
      toolId: row.tool_id as string | undefined,
      memoryIds: JSON.parse((row.memory_ids as string) ?? '[]'),
      input: row.input as string | undefined,
      output: row.output as string | undefined,
      durationMs: row.duration_ms as number | undefined,
      tokensUsed: row.tokens_used as number | undefined,
      confidence: row.confidence as number | undefined,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      createdAt: new Date(row.created_at as string),
    };
  }
}
