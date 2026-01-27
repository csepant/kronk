/**
 * Create Task Tool Handler
 *
 * Adds tasks to the background queue for async processing.
 * Tasks are picked up and processed by the daemon's QueueManager.
 */

import type { KronkDatabase } from '../../db/client.js';
import type { ToolSchema, ToolHandler } from '../manager.js';

export const createTaskToolSchema: ToolSchema = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      description: 'Task type (must have registered handler)',
    },
    payload: {
      type: 'object',
      description: 'Data passed to the handler',
    },
    priority: {
      type: 'number',
      description: 'Higher = more urgent (default: 0)',
    },
    maxRetries: {
      type: 'number',
      description: 'Retry attempts on failure (default: 3)',
    },
  },
  required: ['type'],
};

export interface CreateTaskResult {
  taskId: string;
  status: 'pending';
}

/**
 * Create a task handler that inserts directly into the queue table
 */
export function createTaskHandler(db: KronkDatabase): ToolHandler {
  return async (params: Record<string, unknown>): Promise<CreateTaskResult> => {
    const type = params.type as string;
    const payload = params.payload as Record<string, unknown> | undefined;
    const priority = (params.priority as number) ?? 0;
    const maxRetries = (params.maxRetries as number) ?? 3;

    const result = await db.query(
      `INSERT INTO task_queue (type, payload, priority, max_retries)
       VALUES (?, ?, ?, ?)
       RETURNING id`,
      [
        type,
        payload ? JSON.stringify(payload) : null,
        priority,
        maxRetries,
      ]
    );

    const taskId = result.rows[0].id as string;

    return {
      taskId,
      status: 'pending',
    };
  };
}
