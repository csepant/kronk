/**
 * Kronk Database Client
 * 
 * TursoDB (libSQL) client wrapper with connection management
 * and query helpers for the Kronk schema.
 */

import { createClient, type Client, type ResultSet, type InArgs } from '@libsql/client';
import { getSchemaSQL, SCHEMA_VERSION } from './schema.js';

export interface KronkDbConfig {
  /** Path to local SQLite file or Turso URL */
  url: string;
  /** Auth token for Turso cloud (optional for local) */
  authToken?: string;
  /** Sync URL for embedded replicas */
  syncUrl?: string;
  /** Sync interval in seconds */
  syncInterval?: number;
  /** Enable vector search with embeddings */
  useVectorSearch?: boolean;
}

export class KronkDatabase {
  private client: Client;
  private config: KronkDbConfig;
  private initialized = false;

  constructor(config: KronkDbConfig) {
    this.config = config;
    this.client = createClient({
      url: config.url,
      authToken: config.authToken,
      syncUrl: config.syncUrl,
      syncInterval: config.syncInterval,
    });
  }

  /**
   * Check if vector search is enabled
   */
  isVectorSearchEnabled(): boolean {
    return this.config.useVectorSearch ?? false;
  }

  /**
   * Initialize the database schema
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const schemaSQL = getSchemaSQL(this.config.useVectorSearch ?? false);

    // Execute schema creation - split by semicolon and filter empty/comment-only statements
    const statements = schemaSQL.split(';')
      .map(s => s.trim())
      .filter(s => {
        // Remove empty statements
        if (s.length === 0) return false;
        // Remove comment-only statements (no actual SQL)
        const withoutComments = s.replace(/--.*$/gm, '').trim();
        return withoutComments.length > 0;
      });

    for (const statement of statements) {
      try {
        await this.client.execute(statement);
      } catch (error) {
        const preview = statement.slice(0, 100).replace(/\n/g, ' ');
        console.error(`[Kronk] Schema error on: ${preview}...`);
        console.error(`[Kronk] Error: ${error instanceof Error ? error.message : error}`);
        throw error;
      }
    }

    this.initialized = true;
    console.log(`[Kronk] Database initialized (schema v${SCHEMA_VERSION})`);
  }

  /**
   * Get the raw libSQL client for direct queries
   */
  getClient(): Client {
    return this.client;
  }

  /**
   * Execute a query with parameters
   */
  async query<T = unknown>(sql: string, args?: unknown[]): Promise<ResultSet> {
    return this.client.execute({ sql, args: (args ?? []) as InArgs });
  }

  /**
   * Execute a batch of queries in a transaction
   */
  async transaction(queries: Array<{ sql: string; args?: unknown[] }>): Promise<ResultSet[]> {
    return this.client.batch(
      queries.map(q => ({ sql: q.sql, args: (q.args ?? []) as InArgs })),
      'write'
    );
  }

  /**
   * Vector similarity search helper
   * Uses libSQL's native vector_distance_cos function
   * @throws Error if vector search is not enabled
   */
  async vectorSearch(
    table: 'memory' | 'journal',
    embedding: number[],
    options: {
      limit?: number;
      minSimilarity?: number;
      filter?: string;
      filterArgs?: unknown[];
    } = {}
  ): Promise<Array<{ id: string; content: string; similarity: number; [key: string]: unknown }>> {
    if (!this.isVectorSearchEnabled()) {
      throw new Error(
        'Vector search is not enabled. Initialize with --vector-search flag or set useVectorSearch: true in config.'
      );
    }

    const { limit = 10, minSimilarity = 0.5, filter, filterArgs = [] } = options;

    // Convert embedding array to vector blob format
    const vectorBlob = `vector('[${embedding.join(',')}]')`;

    const whereClause = filter ? `AND ${filter}` : '';

    const sql = `
      SELECT 
        *,
        (1 - vector_distance_cos(embedding, ${vectorBlob})) as similarity
      FROM ${table}
      WHERE embedding IS NOT NULL
        ${whereClause}
        AND (1 - vector_distance_cos(embedding, ${vectorBlob})) >= ?
      ORDER BY similarity DESC
      LIMIT ?
    `;

    const result = await this.query(sql, [...filterArgs, minSimilarity, limit]);

    return result.rows.map(row => ({
      id: row.id as string,
      content: row.content as string,
      similarity: row.similarity as number,
      ...row,
    }));
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    this.client.close();
  }

  /**
   * Get database statistics
   */
  async getStats(): Promise<{
    memoryCount: { system2: number; working: number; system1: number };
    journalCount: number;
    toolCount: number;
  }> {
    const [memoryStats, journalCount, toolCount] = await Promise.all([
      this.query(`SELECT tier, COUNT(*) as count FROM memory GROUP BY tier`),
      this.query(`SELECT COUNT(*) as count FROM journal`),
      this.query(`SELECT COUNT(*) as count FROM tools WHERE enabled = 1`),
    ]);

    const tierCounts = { system2: 0, working: 0, system1: 0 };
    for (const row of memoryStats.rows) {
      const tier = row.tier as keyof typeof tierCounts;
      tierCounts[tier] = row.count as number;
    }

    return {
      memoryCount: tierCounts,
      journalCount: (journalCount.rows[0]?.count as number) ?? 0,
      toolCount: (toolCount.rows[0]?.count as number) ?? 0,
    };
  }
}

/**
 * Create a Kronk database instance with local file storage
 */
export function createLocalDb(dbPath: string, options?: { useVectorSearch?: boolean }): KronkDatabase {
  return new KronkDatabase({
    url: `file:${dbPath}`,
    useVectorSearch: options?.useVectorSearch,
  });
}

/**
 * Create a Kronk database instance with Turso cloud
 */
export function createTursoDb(url: string, authToken: string): KronkDatabase {
  return new KronkDatabase({
    url,
    authToken,
  });
}

/**
 * Create a Kronk database with embedded replica (local + sync to Turso)
 */
export function createEmbeddedReplicaDb(
  localPath: string,
  syncUrl: string,
  authToken: string,
  syncInterval = 60
): KronkDatabase {
  return new KronkDatabase({
    url: `file:${localPath}`,
    syncUrl,
    authToken,
    syncInterval,
  });
}
