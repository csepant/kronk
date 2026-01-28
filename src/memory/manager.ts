/**
 * Kronk Memory Manager
 * 
 * Manages tiered memory with context limits:
 * - System 2: Long-horizon strategic memory
 * - Working: Current task context
 * - System 1: Short-term reactive memory
 */

import type { KronkDatabase } from '../db/client.js';
import { MEMORY_TIERS, TOTAL_CONTEXT_BUDGET, type MemoryTier, VECTOR_DIMENSIONS } from '../db/schema.js';

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

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: Date;
  tokens: number;
  toolCallId?: string;
}

export interface ContextWindow {
  system2: Memory[];
  working: Memory[];
  system1: Memory[];
  conversation: ConversationMessage[];
  totalTokens: number;
  tierTokens: Record<MemoryTier, number>;
}

export interface TierAllocation {
  tier: MemoryTier;
  currentTokens: number;
  maxTokens: number;
  usage: number; // 0-1
  needsSummarization: boolean;
}

export type SummarizerFunction = (content: string, targetTokens: number) => Promise<string>;

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
  private conversation: ConversationMessage[] = [];
  private conversationTokens = 0;
  private summarizer?: SummarizerFunction;
  private tierLimits: Record<MemoryTier, number>;

  constructor(db: KronkDatabase, embedder?: EmbeddingProvider) {
    this.db = db;
    this.embedder = embedder;
    // Initialize with default tier limits
    this.tierLimits = {
      system2: MEMORY_TIERS.system2.maxTokens,
      working: MEMORY_TIERS.working.maxTokens,
      system1: MEMORY_TIERS.system1.maxTokens,
    };
  }

  /**
   * Set the embedding provider (can be changed at runtime)
   */
  setEmbedder(embedder: EmbeddingProvider): void {
    this.embedder = embedder;
  }

  /**
   * Set the summarizer function for dynamic memory compression
   */
  setSummarizer(summarizer: SummarizerFunction): void {
    this.summarizer = summarizer;
  }

  /**
   * Add a message to the conversation history (stored in working memory)
   */
  addConversationMessage(
    role: ConversationMessage['role'],
    content: string,
    toolCallId?: string
  ): void {
    const tokens = estimateTokens(content);
    this.conversation.push({
      role,
      content,
      timestamp: new Date(),
      tokens,
      toolCallId,
    });
    this.conversationTokens += tokens;
  }

  /**
   * Get the current conversation history
   */
  getConversation(): ConversationMessage[] {
    return [...this.conversation];
  }

  /**
   * Get current conversation token count
   */
  getConversationTokens(): number {
    return this.conversationTokens;
  }

  /**
   * Clear conversation history (e.g., at session end)
   */
  clearConversation(): void {
    this.conversation = [];
    this.conversationTokens = 0;
  }

  /**
   * Get tier allocation status for dynamic management
   */
  async getTierAllocations(): Promise<TierAllocation[]> {
    const stats = await this.getStats();
    const allocations: TierAllocation[] = [];

    for (const tier of ['system2', 'working', 'system1'] as MemoryTier[]) {
      const config = MEMORY_TIERS[tier];
      const currentTokens = stats[tier].totalTokens +
        (tier === 'working' ? this.conversationTokens : 0);
      const maxTokens = this.tierLimits[tier];
      const usage = currentTokens / maxTokens;

      allocations.push({
        tier,
        currentTokens,
        maxTokens,
        usage,
        needsSummarization: usage >= config.summarizationTrigger,
      });
    }

    return allocations;
  }

  /**
   * Resize tier limits dynamically based on usage patterns
   * Redistributes tokens from underutilized tiers to overutilized ones
   */
  async resizeTiers(options: {
    preserveMinimums?: boolean;
    totalBudget?: number;
  } = {}): Promise<Record<MemoryTier, number>> {
    const { preserveMinimums = true, totalBudget = TOTAL_CONTEXT_BUDGET * 0.75 } = options;
    const allocations = await this.getTierAllocations();

    // Calculate how much each tier actually needs
    const needs: Record<MemoryTier, number> = {
      system2: 0,
      working: 0,
      system1: 0,
    };

    for (const alloc of allocations) {
      const config = MEMORY_TIERS[alloc.tier];
      const minTokens = preserveMinimums ? config.minTokens : 0;

      if (alloc.usage > 0.9) {
        // Tier is nearly full, request more
        needs[alloc.tier] = Math.max(alloc.currentTokens * 1.2, minTokens);
      } else if (alloc.usage > 0.5) {
        // Moderate usage, keep current allocation
        needs[alloc.tier] = Math.max(alloc.maxTokens, minTokens);
      } else {
        // Low usage, can give up some space
        needs[alloc.tier] = Math.max(alloc.currentTokens * 1.5, minTokens);
      }
    }

    // Normalize to fit within budget
    const totalNeeded = needs.system2 + needs.working + needs.system1;
    const scale = totalBudget / totalNeeded;

    for (const tier of ['system2', 'working', 'system1'] as MemoryTier[]) {
      const config = MEMORY_TIERS[tier];
      const scaled = Math.floor(needs[tier] * scale);
      this.tierLimits[tier] = preserveMinimums
        ? Math.max(scaled, config.minTokens)
        : scaled;
    }

    return { ...this.tierLimits };
  }

  /**
   * Summarize conversation history to reduce token count
   * Keeps recent messages intact and summarizes older ones
   */
  async summarizeConversation(options: {
    keepRecentCount?: number;
    targetTokens?: number;
  } = {}): Promise<{ summarized: number; newTokens: number }> {
    if (!this.summarizer) {
      throw new Error('Summarizer not set. Call setSummarizer() first.');
    }

    const { keepRecentCount = 4, targetTokens } = options;
    const target = targetTokens ?? Math.floor(this.tierLimits.working * 0.5);

    if (this.conversation.length <= keepRecentCount) {
      return { summarized: 0, newTokens: this.conversationTokens };
    }

    // Split into messages to summarize and messages to keep
    const toSummarize = this.conversation.slice(0, -keepRecentCount);
    const toKeep = this.conversation.slice(-keepRecentCount);

    if (toSummarize.length === 0) {
      return { summarized: 0, newTokens: this.conversationTokens };
    }

    // Format messages for summarization
    const conversationText = toSummarize
      .map(m => `${m.role}: ${m.content}`)
      .join('\n\n');

    const tokensToSummarize = toSummarize.reduce((sum, m) => sum + m.tokens, 0);
    const summaryTargetTokens = Math.floor(tokensToSummarize * 0.3); // Compress to ~30%

    // Generate summary
    const summary = await this.summarizer(conversationText, summaryTargetTokens);
    const summaryTokens = estimateTokens(summary);

    // Replace old messages with summary
    this.conversation = [
      {
        role: 'assistant',
        content: `[Previous conversation summary]\n${summary}`,
        timestamp: toSummarize[toSummarize.length - 1].timestamp,
        tokens: summaryTokens,
      },
      ...toKeep,
    ];

    // Recalculate total tokens
    this.conversationTokens = this.conversation.reduce((sum, m) => sum + m.tokens, 0);

    return {
      summarized: toSummarize.length,
      newTokens: this.conversationTokens,
    };
  }

  /**
   * Automatically manage memory tiers - summarize if over threshold
   */
  async autoManage(): Promise<{
    conversationSummarized: boolean;
    tiersResized: boolean;
    tiersSummarized: MemoryTier[];
  }> {
    const result = {
      conversationSummarized: false,
      tiersResized: false,
      tiersSummarized: [] as MemoryTier[],
    };

    const allocations = await this.getTierAllocations();

    // Check if any tier needs summarization
    const overThreshold = allocations.filter(a => a.needsSummarization);

    if (overThreshold.length > 0) {
      // Resize tiers to redistribute space
      await this.resizeTiers();
      result.tiersResized = true;

      // Check if working memory (conversation) needs summarization
      const workingAlloc = allocations.find(a => a.tier === 'working');
      if (workingAlloc?.needsSummarization && this.summarizer) {
        await this.summarizeConversation();
        result.conversationSummarized = true;
      }

      // Note: Tier memory summarization is handled by consolidate()
      // which requires the caller to provide a summarizer for persistence
      for (const alloc of overThreshold) {
        if (alloc.tier !== 'working') {
          result.tiersSummarized.push(alloc.tier);
        }
      }
    }

    return result;
  }

  /**
   * Get current tier limits
   */
  getTierLimits(): Record<MemoryTier, number> {
    return { ...this.tierLimits };
  }

  /**
   * Set custom tier limits
   */
  setTierLimits(limits: Partial<Record<MemoryTier, number>>): void {
    for (const [tier, limit] of Object.entries(limits)) {
      if (tier in this.tierLimits && typeof limit === 'number') {
        this.tierLimits[tier as MemoryTier] = limit;
      }
    }
  }

  /**
   * Store a new memory
   */
  async store(input: MemoryInput): Promise<Memory> {
    const tierConfig = MEMORY_TIERS[input.tier];
    const importance = input.importance ?? tierConfig.defaultImportance;

    // Generate embedding if provider is available and vector search is enabled
    let sql: string;
    let args: unknown[];

    if (this.embedder && this.db.isVectorSearchEnabled()) {
      const embedding = await this.embedder.embed(input.content);
      const embeddingBlob = `vector('[${embedding.join(',')}]')`;

      sql = `
        INSERT INTO memory (
          tier, content, summary, embedding,
          importance, decay_rate, source, tags, related_ids, expires_at
        ) VALUES (
          ?, ?, ?, ${embeddingBlob},
          ?, ?, ?, ?, ?, ?
        )
        RETURNING *
      `;

      args = [
        input.tier,
        input.content,
        input.summary ?? null,
        importance,
        tierConfig.decayRate,
        input.source ?? 'agent',
        JSON.stringify(input.tags ?? []),
        JSON.stringify(input.relatedIds ?? []),
        input.expiresAt?.toISOString() ?? null,
      ];
    } else {
      // Text-only schema without embedding column
      sql = `
        INSERT INTO memory (
          tier, content, summary,
          importance, decay_rate, source, tags, related_ids, expires_at
        ) VALUES (
          ?, ?, ?,
          ?, ?, ?, ?, ?, ?
        )
        RETURNING *
      `;

      args = [
        input.tier,
        input.content,
        input.summary ?? null,
        importance,
        tierConfig.decayRate,
        input.source ?? 'agent',
        JSON.stringify(input.tags ?? []),
        JSON.stringify(input.relatedIds ?? []),
        input.expiresAt?.toISOString() ?? null,
      ];
    }

    const result = await this.db.query(sql, args);
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
   * Search memories by semantic similarity (if embedder available) or text matching
   */
  async search(
    query: string,
    options: {
      tier?: MemoryTier;
      limit?: number;
      minSimilarity?: number;
    } = {}
  ): Promise<Array<Memory & { similarity: number }>> {
    // Use vector search if embedder is available
    if (this.embedder) {
      return this.vectorSearch(query, options);
    }

    // Fall back to text-based search
    return this.textSearch(query, options);
  }

  /**
   * Search memories using vector embeddings
   */
  private async vectorSearch(
    query: string,
    options: {
      tier?: MemoryTier;
      limit?: number;
      minSimilarity?: number;
    } = {}
  ): Promise<Array<Memory & { similarity: number }>> {
    if (!this.embedder) {
      throw new Error('Embedding provider required for vector search');
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
   * Search memories using text-based LIKE matching
   */
  private async textSearch(
    query: string,
    options: {
      tier?: MemoryTier;
      limit?: number;
    } = {}
  ): Promise<Array<Memory & { similarity: number }>> {
    const { tier, limit = 10 } = options;

    // Split query into keywords for better matching
    const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 2);
    if (keywords.length === 0) {
      return [];
    }

    // Build WHERE clause for text matching
    const conditions: string[] = [];
    const args: unknown[] = [];

    if (tier) {
      conditions.push('tier = ?');
      args.push(tier);
    }

    // Match any keyword in content or summary
    const keywordConditions = keywords.map(() => '(LOWER(content) LIKE ? OR LOWER(summary) LIKE ?)');
    conditions.push(`(${keywordConditions.join(' OR ')})`);
    for (const keyword of keywords) {
      args.push(`%${keyword}%`, `%${keyword}%`);
    }

    conditions.push('(expires_at IS NULL OR expires_at > datetime(\'now\'))');

    const sql = `
      SELECT * FROM memory
      WHERE ${conditions.join(' AND ')}
      ORDER BY importance DESC, last_accessed_at DESC
      LIMIT ?
    `;
    args.push(limit);

    const result = await this.db.query(sql, args);

    // Update access counts for retrieved memories
    if (result.rows.length > 0) {
      const ids = result.rows.map(r => r.id as string);
      await this.db.query(
        `UPDATE memory SET access_count = access_count + 1, last_accessed_at = datetime('now')
         WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
    }

    // Calculate a simple relevance score based on keyword matches
    return result.rows.map(row => {
      const content = ((row.content as string) + ' ' + ((row.summary as string) ?? '')).toLowerCase();
      const matchCount = keywords.filter(k => content.includes(k)).length;
      const similarity = matchCount / keywords.length;

      return {
        ...this.rowToMemory(row),
        similarity,
      };
    });
  }

  /**
   * Build the current context window from all memory tiers
   * Includes conversation history in working memory
   */
  async buildContextWindow(): Promise<ContextWindow> {
    const context: ContextWindow = {
      system2: [],
      working: [],
      system1: [],
      conversation: [...this.conversation],
      totalTokens: 0,
      tierTokens: {
        system2: 0,
        working: 0,
        system1: 0,
      },
    };

    // Fetch memories for each tier, respecting dynamic token limits
    for (const tier of ['system2', 'working', 'system1'] as MemoryTier[]) {
      const tierLimit = this.tierLimits[tier];
      let tierTokens = 0;

      // For working memory, account for conversation tokens first
      const reservedTokens = tier === 'working' ? this.conversationTokens : 0;
      const availableTokens = tierLimit - reservedTokens;

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

        // Stop if we'd exceed available tier limit
        if (tierTokens + tokens > availableTokens) break;

        context[tier].push(memory);
        tierTokens += tokens;
      }

      context.tierTokens[tier] = tierTokens + reservedTokens;
      context.totalTokens += tierTokens + reservedTokens;
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

    if (context.conversation.length > 0) {
      sections.push('\n## Conversation History\n');
      sections.push(context.conversation.map(m => {
        const roleLabel = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Tool';
        return `**${roleLabel}**: ${m.content}`;
      }).join('\n\n'));
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
