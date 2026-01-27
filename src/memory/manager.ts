/**
 * Kronk Memory Manager
 * 
 * Manages tiered memory with context limits:
 * - System 2: Long-horizon strategic memory
 * - Working: Current task context
 * - System 1: Short-term reactive memory
 */

import type { KronkDatabase } from '../db/client.js';
import { MEMORY_TIERS, type MemoryTier, VECTOR_DIMENSIONS } from '../db/schema.js';

export interface Memory {
  id: string;
  tier: MemoryTier;
  content: string;
  summary?: string;
  importance: number;
  accessCount: number;
  source: 'user' | 'agent' | 'tool' | 'inference';
  tags: string[];
  relatedIds: string[];
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date;
  expiresAt?: Date;
}

export interface MemoryInput {
  tier: MemoryTier;
  content: string;
  summary?: string;
  importance?: number;
  source?: Memory['source'];
  tags?: string[];
  relatedIds?: string[];
  expiresAt?: Date;
}

export interface ContextWindow {
  system2: Memory[];
  working: Memory[];
  system1: Memory[];
  totalTokens: number;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * Simple token estimation (4 chars ≈ 1 token)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class MemoryManager {
  private db: KronkDatabase;
  private embedder?: EmbeddingProvider;

  constructor(db: KronkDatabase, embedder?: EmbeddingProvider) {
    this.db = db;
    this.embedder = embedder;
  }

  /**
   * Set the embedding provider (can be changed at runtime)
   */
  setEmbedder(embedder: EmbeddingProvider): void {
    this.embedder = embedder;
  }

  /**
   * Store a new memory
   */
  async store(input: MemoryInput): Promise<Memory> {
    const tierConfig = MEMORY_TIERS[input.tier];
    const importance = input.importance ?? tierConfig.defaultImportance;

    // Generate embedding if provider is available
    let embeddingBlob: string | null = null;
    if (this.embedder) {
      const embedding = await this.embedder.embed(input.content);
      embeddingBlob = `vector('[${embedding.join(',')}]')`;
    }

    const sql = `
      INSERT INTO memory (
        tier, content, summary, embedding,
        importance, decay_rate, source, tags, related_ids, expires_at
      ) VALUES (
        ?, ?, ?, ${embeddingBlob ?? 'NULL'},
        ?, ?, ?, ?, ?, ?
      )
      RETURNING *
    `;

    const result = await this.db.query(sql, [
      input.tier,
      input.content,
      input.summary ?? null,
      importance,
      tierConfig.decayRate,
      input.source ?? 'agent',
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.relatedIds ?? []),
      input.expiresAt?.toISOString() ?? null,
    ]);

    const row = result.rows[0];
    return this.rowToMemory(row);
  }

  /**
   * Retrieve a memory by ID and update access count
   */
  async get(id: string): Promise<Memory | null> {
    const sql = `
      UPDATE memory 
      SET access_count = access_count + 1, 
          last_accessed_at = datetime('now')
      WHERE id = ?
      RETURNING *
    `;

    const result = await this.db.query(sql, [id]);
    if (result.rows.length === 0) return null;

    return this.rowToMemory(result.rows[0]);
  }

  /**
   * Search memories by semantic similarity
   */
  async search(
    query: string,
    options: {
      tier?: MemoryTier;
      limit?: number;
      minSimilarity?: number;
    } = {}
  ): Promise<Array<Memory & { similarity: number }>> {
    if (!this.embedder) {
      throw new Error('Embedding provider required for semantic search');
    }

    const embedding = await this.embedder.embed(query);
    const filter = options.tier ? 'tier = ?' : undefined;
    const filterArgs = options.tier ? [options.tier] : undefined;

    const results = await this.db.vectorSearch('memory', embedding, {
      limit: options.limit ?? 10,
      minSimilarity: options.minSimilarity ?? 0.5,
      filter,
      filterArgs,
    });

    // Update access counts for retrieved memories
    if (results.length > 0) {
      const ids = results.map(r => r.id);
      await this.db.query(
        `UPDATE memory SET access_count = access_count + 1, last_accessed_at = datetime('now')
         WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
    }

    return results.map(row => ({
      ...this.rowToMemory(row),
      similarity: row.similarity,
    }));
  }

  /**
   * Build the current context window from all memory tiers
   */
  async buildContextWindow(): Promise<ContextWindow> {
    const context: ContextWindow = {
      system2: [],
      working: [],
      system1: [],
      totalTokens: 0,
    };

    // Fetch memories for each tier, respecting token limits
    for (const tier of ['system2', 'working', 'system1'] as MemoryTier[]) {
      const tierConfig = MEMORY_TIERS[tier];
      let tierTokens = 0;

      // Query memories ordered by importance and recency
      const sql = `
        SELECT * FROM memory
        WHERE tier = ?
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY importance DESC, last_accessed_at DESC
      `;

      const result = await this.db.query(sql, [tier]);

      for (const row of result.rows) {
        const memory = this.rowToMemory(row);
        const content = memory.summary ?? memory.content;
        const tokens = estimateTokens(content);

        // Stop if we'd exceed tier limit
        if (tierTokens + tokens > tierConfig.maxTokens) break;

        context[tier].push(memory);
        tierTokens += tokens;
      }

      context.totalTokens += tierTokens;
    }

    return context;
  }

  /**
   * Serialize context window to a prompt-friendly string
   */
  formatContextForPrompt(context: ContextWindow): string {
    const sections: string[] = [];

    if (context.system2.length > 0) {
      sections.push('## Long-Term Memory (Strategic Context)\n');
      sections.push(context.system2.map(m => `- ${m.summary ?? m.content}`).join('\n'));
    }

    if (context.working.length > 0) {
      sections.push('\n## Working Memory (Current Tasks)\n');
      sections.push(context.working.map(m => `- ${m.summary ?? m.content}`).join('\n'));
    }

    if (context.system1.length > 0) {
      sections.push('\n## Recent Context (Short-Term)\n');
      sections.push(context.system1.map(m => `- ${m.summary ?? m.content}`).join('\n'));
    }

    return sections.join('\n');
  }

  /**
   * Promote memory to a higher tier (e.g., system1 -> working -> system2)
   */
  async promote(id: string): Promise<Memory | null> {
    const memory = await this.get(id);
    if (!memory) return null;

    const promotionMap: Partial<Record<MemoryTier, MemoryTier>> = {
      system1: 'working',
      working: 'system2',
    };

    const newTier = promotionMap[memory.tier];
    if (!newTier) return memory; // Already at highest tier

    const newConfig = MEMORY_TIERS[newTier];

    await this.db.query(
      `UPDATE memory SET tier = ?, importance = ?, decay_rate = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [newTier, Math.max(memory.importance, newConfig.defaultImportance), newConfig.decayRate, id]
    );

    return this.get(id);
  }

  /**
   * Demote memory to a lower tier
   */
  async demote(id: string): Promise<Memory | null> {
    const memory = await this.get(id);
    if (!memory) return null;

    const demotionMap: Partial<Record<MemoryTier, MemoryTier>> = {
      system2: 'working',
      working: 'system1',
    };

    const newTier = demotionMap[memory.tier];
    if (!newTier) return memory; // Already at lowest tier

    const newConfig = MEMORY_TIERS[newTier];

    await this.db.query(
      `UPDATE memory SET tier = ?, decay_rate = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [newTier, newConfig.decayRate, id]
    );

    return this.get(id);
  }

  /**
   * Apply decay to memories based on time since last access
   */
  async applyDecay(): Promise<number> {
    // Reduce importance based on decay rate and time since last access
    const sql = `
      UPDATE memory
      SET importance = MAX(0, importance - (
        decay_rate * (julianday('now') - julianday(last_accessed_at))
      )),
      updated_at = datetime('now')
      WHERE importance > 0
        AND last_accessed_at < datetime('now', '-1 hour')
    `;

    const result = await this.db.query(sql);
    return result.rowsAffected;
  }

  /**
   * Consolidate memories within a tier (compress old memories into summaries)
   */
  async consolidate(tier: MemoryTier, summarizer: (memories: Memory[]) => Promise<string>): Promise<void> {
    const tierConfig = MEMORY_TIERS[tier];

    // Count memories in tier
    const countResult = await this.db.query(
      'SELECT COUNT(*) as count FROM memory WHERE tier = ?',
      [tier]
    );
    const count = countResult.rows[0]?.count as number;

    if (count < tierConfig.consolidationThreshold) return;

    // Get oldest, least important memories to consolidate
    const toConsolidate = await this.db.query(
      `SELECT * FROM memory 
       WHERE tier = ? 
       ORDER BY importance ASC, created_at ASC 
       LIMIT ?`,
      [tier, Math.floor(count * 0.3)] // Consolidate bottom 30%
    );

    if (toConsolidate.rows.length < 2) return;

    const memories = toConsolidate.rows.map(r => this.rowToMemory(r));
    const summary = await summarizer(memories);

    // Store consolidated memory
    await this.store({
      tier,
      content: summary,
      importance: memories.reduce((sum, m) => sum + m.importance, 0) / memories.length,
      source: 'inference',
      tags: ['consolidated'],
      relatedIds: memories.map(m => m.id),
    });

    // Archive or delete original memories
    const ids = memories.map(m => m.id);
    await this.db.query(
      `DELETE FROM memory WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
  }

  /**
   * Clean up expired memories
   */
  async cleanup(): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM memory WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`
    );
    return result.rowsAffected;
  }

  /**
   * Get memory statistics by tier
   */
  async getStats(): Promise<Record<MemoryTier, { count: number; avgImportance: number; totalTokens: number }>> {
    const sql = `
      SELECT 
        tier,
        COUNT(*) as count,
        AVG(importance) as avg_importance,
        SUM(LENGTH(COALESCE(summary, content)) / 4) as est_tokens
      FROM memory
      GROUP BY tier
    `;

    const result = await this.db.query(sql);
    const stats: Record<MemoryTier, { count: number; avgImportance: number; totalTokens: number }> = {
      system2: { count: 0, avgImportance: 0, totalTokens: 0 },
      working: { count: 0, avgImportance: 0, totalTokens: 0 },
      system1: { count: 0, avgImportance: 0, totalTokens: 0 },
    };

    for (const row of result.rows) {
      const tier = row.tier as MemoryTier;
      stats[tier] = {
        count: row.count as number,
        avgImportance: row.avg_importance as number,
        totalTokens: row.est_tokens as number,
      };
    }

    return stats;
  }

  /**
   * Convert database row to Memory object
   */
  private rowToMemory(row: Record<string, unknown>): Memory {
    return {
      id: row.id as string,
      tier: row.tier as MemoryTier,
      content: row.content as string,
      summary: row.summary as string | undefined,
      importance: row.importance as number,
      accessCount: row.access_count as number,
      source: row.source as Memory['source'],
      tags: JSON.parse((row.tags as string) ?? '[]'),
      relatedIds: JSON.parse((row.related_ids as string) ?? '[]'),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      lastAccessedAt: new Date(row.last_accessed_at as string),
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : undefined,
    };
  }
}
