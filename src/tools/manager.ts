/**
 * Kronk Tools Manager
 * 
 * Manages tool registration, discovery, and invocation for the agent.
 * Tools are persisted in the database and can be dynamically loaded.
 */

import type { KronkDatabase } from '../db/client.js';

export interface ToolSchema {
  type: 'object';
  properties: Record<string, {
    type: string;
    description?: string;
    enum?: string[];
    items?: { type: string };
    default?: unknown;
  }>;
  required?: string[];
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  schema: ToolSchema;
  handler: string;
  enabled: boolean;
  priority: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolInput {
  name: string;
  description: string;
  schema: ToolSchema;
  handler: string;
  enabled?: boolean;
  priority?: number;
  metadata?: Record<string, unknown>;
}

export type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;

export class ToolsManager {
  private db: KronkDatabase;
  private handlers: Map<string, ToolHandler> = new Map();

  constructor(db: KronkDatabase) {
    this.db = db;
  }

  /**
   * Register a tool in the database
   */
  async register(input: ToolInput): Promise<Tool> {
    const sql = `
      INSERT INTO tools (name, description, schema, handler, enabled, priority, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        schema = excluded.schema,
        handler = excluded.handler,
        enabled = excluded.enabled,
        priority = excluded.priority,
        metadata = excluded.metadata,
        updated_at = datetime('now')
      RETURNING *
    `;

    const result = await this.db.query(sql, [
      input.name,
      input.description,
      JSON.stringify(input.schema),
      input.handler,
      input.enabled ?? true ? 1 : 0,
      input.priority ?? 0,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ]);

    return this.rowToTool(result.rows[0]);
  }

  /**
   * Register a runtime handler for a tool
   */
  registerHandler(toolName: string, handler: ToolHandler): void {
    this.handlers.set(toolName, handler);
  }

  /**
   * Get a tool by name
   */
  async get(name: string): Promise<Tool | null> {
    const result = await this.db.query('SELECT * FROM tools WHERE name = ?', [name]);
    if (result.rows.length === 0) return null;
    return this.rowToTool(result.rows[0]);
  }

  /**
   * Get a tool by ID
   */
  async getById(id: string): Promise<Tool | null> {
    const result = await this.db.query('SELECT * FROM tools WHERE id = ?', [id]);
    if (result.rows.length === 0) return null;
    return this.rowToTool(result.rows[0]);
  }

  /**
   * List all enabled tools
   */
  async listEnabled(): Promise<Tool[]> {
    const result = await this.db.query(
      'SELECT * FROM tools WHERE enabled = 1 ORDER BY priority DESC, name ASC'
    );
    return result.rows.map(r => this.rowToTool(r));
  }

  /**
   * List all tools (including disabled)
   */
  async listAll(): Promise<Tool[]> {
    const result = await this.db.query('SELECT * FROM tools ORDER BY priority DESC, name ASC');
    return result.rows.map(r => this.rowToTool(r));
  }

  /**
   * Enable a tool
   */
  async enable(name: string): Promise<boolean> {
    const result = await this.db.query(
      'UPDATE tools SET enabled = 1, updated_at = datetime(\'now\') WHERE name = ?',
      [name]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Disable a tool
   */
  async disable(name: string): Promise<boolean> {
    const result = await this.db.query(
      'UPDATE tools SET enabled = 0, updated_at = datetime(\'now\') WHERE name = ?',
      [name]
    );
    return result.rowsAffected > 0;
  }

  /**
   * Delete a tool
   */
  async delete(name: string): Promise<boolean> {
    const result = await this.db.query('DELETE FROM tools WHERE name = ?', [name]);
    this.handlers.delete(name);
    return result.rowsAffected > 0;
  }

  /**
   * Invoke a tool by name
   */
  async invoke(name: string, params: Record<string, unknown>): Promise<{
    success: boolean;
    result?: unknown;
    error?: string;
    duration: number;
  }> {
    const startTime = Date.now();

    const tool = await this.get(name);
    if (!tool) {
      return {
        success: false,
        error: `Tool '${name}' not found`,
        duration: Date.now() - startTime,
      };
    }

    if (!tool.enabled) {
      return {
        success: false,
        error: `Tool '${name}' is disabled`,
        duration: Date.now() - startTime,
      };
    }

    // Validate params against schema
    const validationError = this.validateParams(params, tool.schema);
    if (validationError) {
      return {
        success: false,
        error: validationError,
        duration: Date.now() - startTime,
      };
    }

    // Get handler
    const handler = this.handlers.get(name);
    if (!handler) {
      return {
        success: false,
        error: `No handler registered for tool '${name}'`,
        duration: Date.now() - startTime,
      };
    }

    try {
      const result = await handler(params);
      return {
        success: true,
        result,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Generate tool descriptions for LLM prompt
   */
  async generateToolPrompt(): Promise<string> {
    const tools = await this.listEnabled();
    if (tools.length === 0) {
      return 'No tools are currently available.';
    }

    const sections = ['# Available Tools\n'];

    for (const tool of tools) {
      sections.push(`## ${tool.name}`);
      sections.push(tool.description);
      sections.push('\n**Parameters:**');
      sections.push('```json');
      sections.push(JSON.stringify(tool.schema, null, 2));
      sections.push('```\n');
    }

    return sections.join('\n');
  }

  /**
   * Validate parameters against tool schema
   */
  private validateParams(params: Record<string, unknown>, schema: ToolSchema): string | null {
    const required = schema.required ?? [];

    for (const field of required) {
      if (!(field in params)) {
        return `Missing required parameter: ${field}`;
      }
    }

    for (const [key, value] of Object.entries(params)) {
      const propSchema = schema.properties[key];
      if (!propSchema) {
        continue; // Allow extra properties
      }

      // Basic type checking
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (propSchema.type !== actualType && value !== null && value !== undefined) {
        return `Invalid type for '${key}': expected ${propSchema.type}, got ${actualType}`;
      }

      // Enum validation
      if (propSchema.enum && !propSchema.enum.includes(value as string)) {
        return `Invalid value for '${key}': must be one of ${propSchema.enum.join(', ')}`;
      }
    }

    return null;
  }

  /**
   * Convert database row to Tool object
   */
  private rowToTool(row: Record<string, unknown>): Tool {
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      schema: JSON.parse(row.schema as string),
      handler: row.handler as string,
      enabled: (row.enabled as number) === 1,
      priority: row.priority as number,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
