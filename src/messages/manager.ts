/**
 * Message Manager
 *
 * Handles persistence of chat messages to the database.
 */

import type { KronkDatabase } from '../db/client.js';
import type { ToolCall } from '../ui/components/ToolOutput.js';

export interface ChatMessageRecord {
  id: string;
  sessionId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  createdAt: Date;
}

export interface MessageInput {
  sessionId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
}

export class MessageManager {
  constructor(private db: KronkDatabase) {}

  /**
   * Add a new message to the database
   */
  async add(input: MessageInput): Promise<ChatMessageRecord> {
    const id = crypto.randomUUID().replace(/-/g, '');
    const toolCallsJson = input.toolCalls ? JSON.stringify(input.toolCalls) : null;

    await this.db.query(
      `INSERT INTO messages (id, session_id, role, content, tool_calls)
       VALUES (?, ?, ?, ?, ?)`,
      [id, input.sessionId ?? null, input.role, input.content, toolCallsJson]
    );

    return {
      id,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      toolCalls: input.toolCalls,
      createdAt: new Date(),
    };
  }

  /**
   * Get messages by session ID
   */
  async getBySession(sessionId: string, limit = 50): Promise<ChatMessageRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC
       LIMIT ?`,
      [sessionId, limit]
    );

    return result.rows.map((row) => this.rowToRecord(row));
  }

  /**
   * Get recent messages (across all sessions)
   */
  async getRecent(limit = 50): Promise<ChatMessageRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM messages
       ORDER BY created_at DESC
       LIMIT ?`,
      [limit]
    );

    // Reverse to get chronological order
    return result.rows.map((row) => this.rowToRecord(row)).reverse();
  }

  /**
   * Clear all messages for a session
   */
  async clearSession(sessionId: string): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM messages WHERE session_id = ?`,
      [sessionId]
    );

    return Number(result.rowsAffected ?? 0);
  }

  /**
   * Clear all messages (dangerous - use with caution)
   */
  async clearAll(): Promise<number> {
    const result = await this.db.query(`DELETE FROM messages`);
    return Number(result.rowsAffected ?? 0);
  }

  /**
   * Get message count
   */
  async getCount(): Promise<number> {
    const result = await this.db.query(
      `SELECT COUNT(*) as count FROM messages`
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * Convert a database row to a ChatMessageRecord
   */
  private rowToRecord(row: Record<string, unknown>): ChatMessageRecord {
    let toolCalls: ToolCall[] | undefined;
    const toolCallsData = row.tool_calls as string | null;
    if (toolCallsData) {
      try {
        toolCalls = JSON.parse(toolCallsData);
      } catch {
        // Ignore parse errors
      }
    }

    return {
      id: row.id as string,
      sessionId: (row.session_id as string | null) ?? undefined,
      role: row.role as 'user' | 'assistant' | 'system',
      content: row.content as string,
      toolCalls,
      createdAt: new Date(row.created_at as string),
    };
  }
}
