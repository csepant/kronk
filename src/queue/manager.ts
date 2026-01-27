/**
 * Kronk Task Queue Manager
 *
 * Background task processing with priority queue, persistent storage,
 * retry logic, and task cancellation support.
 */

import { EventEmitter } from 'node:events';
import type { KronkDatabase } from '../db/client.js';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface QueueTask {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
  priority: number;
  status: TaskStatus;
  retryCount: number;
  maxRetries: number;
  error: string | null;
  result: unknown | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface QueueTaskInput {
  type: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxRetries?: number;
}

export interface QueueManagerConfig {
  /** Maximum concurrent tasks */
  maxConcurrent?: number;
  /** Default max retries for tasks */
  defaultRetries?: number;
  /** Base delay for exponential backoff (ms) */
  retryBaseDelay?: number;
  /** Maximum retry delay (ms) */
  retryMaxDelay?: number;
  /** Poll interval for checking new tasks (ms) */
  pollInterval?: number;
}

export interface QueueEvents {
  'task:added': (task: QueueTask) => void;
  'task:started': (task: QueueTask) => void;
  'task:completed': (task: QueueTask, result: unknown) => void;
  'task:failed': (task: QueueTask, error: Error) => void;
  'task:retry': (task: QueueTask, attempt: number) => void;
  'task:cancelled': (task: QueueTask) => void;
  'queue:empty': () => void;
  'queue:error': (error: Error) => void;
}

export type TaskHandler = (payload: Record<string, unknown> | null) => Promise<unknown>;

const DEFAULT_CONFIG: Required<QueueManagerConfig> = {
  maxConcurrent: 3,
  defaultRetries: 3,
  retryBaseDelay: 1000,
  retryMaxDelay: 60000,
  pollInterval: 1000,
};

export class QueueManager extends EventEmitter {
  private db: KronkDatabase;
  private config: Required<QueueManagerConfig>;
  private handlers: Map<string, TaskHandler> = new Map();
  private runningTasks: Map<string, QueueTask> = new Map();
  private running: boolean = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(db: KronkDatabase, config: QueueManagerConfig = {}) {
    super();
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Type-safe event emitter methods
   */
  override on<K extends keyof QueueEvents>(event: K, listener: QueueEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof QueueEvents>(event: K, ...args: Parameters<QueueEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Register a handler for a task type
   */
  registerHandler(type: string, handler: TaskHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * Unregister a task type handler
   */
  unregisterHandler(type: string): boolean {
    return this.handlers.delete(type);
  }

  /**
   * Add a task to the queue
   */
  async add(input: QueueTaskInput): Promise<QueueTask> {
    const result = await this.db.query(
      `INSERT INTO task_queue (type, payload, priority, max_retries)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
      [
        input.type,
        input.payload ? JSON.stringify(input.payload) : null,
        input.priority ?? 0,
        input.maxRetries ?? this.config.defaultRetries,
      ]
    );

    const task = this.rowToTask(result.rows[0]);
    this.emit('task:added', task);
    return task;
  }

  /**
   * Get a task by ID
   */
  async get(id: string): Promise<QueueTask | null> {
    const result = await this.db.query(
      'SELECT * FROM task_queue WHERE id = ?',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToTask(result.rows[0]);
  }

  /**
   * List tasks with optional filtering
   */
  async list(options: {
    status?: TaskStatus | TaskStatus[];
    type?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<QueueTask[]> {
    let query = 'SELECT * FROM task_queue WHERE 1=1';
    const args: unknown[] = [];

    if (options.status) {
      if (Array.isArray(options.status)) {
        query += ` AND status IN (${options.status.map(() => '?').join(', ')})`;
        args.push(...options.status);
      } else {
        query += ' AND status = ?';
        args.push(options.status);
      }
    }

    if (options.type) {
      query += ' AND type = ?';
      args.push(options.type);
    }

    query += ' ORDER BY priority DESC, created_at ASC';

    if (options.limit) {
      query += ' LIMIT ?';
      args.push(options.limit);
    }

    if (options.offset) {
      query += ' OFFSET ?';
      args.push(options.offset);
    }

    const result = await this.db.query(query, args);
    return result.rows.map(row => this.rowToTask(row));
  }

  /**
   * Cancel a pending task
   */
  async cancel(id: string): Promise<boolean> {
    const task = await this.get(id);
    if (!task || task.status !== 'pending') {
      return false;
    }

    await this.db.query(
      `UPDATE task_queue SET status = 'cancelled', completed_at = datetime('now')
       WHERE id = ? AND status = 'pending'`,
      [id]
    );

    const updated = await this.get(id);
    if (updated && updated.status === 'cancelled') {
      this.emit('task:cancelled', updated);
      return true;
    }
    return false;
  }

  /**
   * Start processing the queue
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.poll();
  }

  /**
   * Stop processing the queue
   */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Check if the queue is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<{
    pending: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    byType: Record<string, number>;
  }> {
    const statusResult = await this.db.query(
      `SELECT status, COUNT(*) as count FROM task_queue GROUP BY status`
    );

    const typeResult = await this.db.query(
      `SELECT type, COUNT(*) as count FROM task_queue WHERE status = 'pending' GROUP BY type`
    );

    const stats = {
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      byType: {} as Record<string, number>,
    };

    for (const row of statusResult.rows) {
      const status = row.status as TaskStatus;
      const count = row.count as number;
      if (status in stats) {
        stats[status] = count;
      }
    }

    for (const row of typeResult.rows) {
      stats.byType[row.type as string] = row.count as number;
    }

    return stats;
  }

  /**
   * Clear completed or failed tasks
   */
  async cleanup(options: {
    status?: TaskStatus[];
    olderThan?: Date;
  } = {}): Promise<number> {
    let query = 'DELETE FROM task_queue WHERE 1=1';
    const args: unknown[] = [];

    const statuses = options.status ?? ['completed', 'failed', 'cancelled'];
    query += ` AND status IN (${statuses.map(() => '?').join(', ')})`;
    args.push(...statuses);

    if (options.olderThan) {
      query += ' AND completed_at < ?';
      args.push(options.olderThan.toISOString());
    }

    const result = await this.db.query(query, args);
    return result.rowsAffected;
  }

  /**
   * Poll for tasks to process
   */
  private poll(): void {
    if (!this.running) {
      return;
    }

    this.processNext().catch(error => {
      this.emit('queue:error', error instanceof Error ? error : new Error(String(error)));
    });

    this.pollTimer = setTimeout(() => this.poll(), this.config.pollInterval);
  }

  /**
   * Process the next available task
   */
  private async processNext(): Promise<void> {
    if (this.runningTasks.size >= this.config.maxConcurrent) {
      return;
    }

    // Get next pending task
    const result = await this.db.query(
      `SELECT * FROM task_queue
       WHERE status = 'pending'
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`
    );

    if (result.rows.length === 0) {
      if (this.runningTasks.size === 0) {
        this.emit('queue:empty');
      }
      return;
    }

    const task = this.rowToTask(result.rows[0]);

    // Check if we have a handler for this task type
    const handler = this.handlers.get(task.type);
    if (!handler) {
      await this.failTask(task, new Error(`No handler registered for task type: ${task.type}`));
      return;
    }

    // Mark task as running
    await this.db.query(
      `UPDATE task_queue SET status = 'running', started_at = datetime('now')
       WHERE id = ?`,
      [task.id]
    );

    task.status = 'running';
    task.startedAt = new Date();
    this.runningTasks.set(task.id, task);
    this.emit('task:started', task);

    // Execute the task
    this.executeTask(task, handler);
  }

  /**
   * Execute a task with retry logic
   */
  private async executeTask(task: QueueTask, handler: TaskHandler): Promise<void> {
    try {
      const result = await handler(task.payload);
      await this.completeTask(task, result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      if (task.retryCount < task.maxRetries) {
        await this.retryTask(task, err);
      } else {
        await this.failTask(task, err);
      }
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  /**
   * Mark a task as completed
   */
  private async completeTask(task: QueueTask, result: unknown): Promise<void> {
    await this.db.query(
      `UPDATE task_queue
       SET status = 'completed', result = ?, completed_at = datetime('now')
       WHERE id = ?`,
      [JSON.stringify(result), task.id]
    );

    task.status = 'completed';
    task.result = result;
    task.completedAt = new Date();
    this.emit('task:completed', task, result);
  }

  /**
   * Schedule a task for retry
   */
  private async retryTask(task: QueueTask, error: Error): Promise<void> {
    const newRetryCount = task.retryCount + 1;
    const delay = Math.min(
      this.config.retryBaseDelay * Math.pow(2, task.retryCount),
      this.config.retryMaxDelay
    );

    await this.db.query(
      `UPDATE task_queue
       SET status = 'pending', retry_count = ?, error = ?, started_at = NULL
       WHERE id = ?`,
      [newRetryCount, error.message, task.id]
    );

    task.retryCount = newRetryCount;
    task.status = 'pending';
    task.error = error.message;
    this.emit('task:retry', task, newRetryCount);

    // Delay before retrying
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Mark a task as failed
   */
  private async failTask(task: QueueTask, error: Error): Promise<void> {
    await this.db.query(
      `UPDATE task_queue
       SET status = 'failed', error = ?, completed_at = datetime('now')
       WHERE id = ?`,
      [error.message, task.id]
    );

    task.status = 'failed';
    task.error = error.message;
    task.completedAt = new Date();
    this.emit('task:failed', task, error);
  }

  /**
   * Convert a database row to a QueueTask
   */
  private rowToTask(row: Record<string, unknown>): QueueTask {
    return {
      id: row.id as string,
      type: row.type as string,
      payload: row.payload ? JSON.parse(row.payload as string) : null,
      priority: row.priority as number,
      status: row.status as TaskStatus,
      retryCount: row.retry_count as number,
      maxRetries: row.max_retries as number,
      error: row.error as string | null,
      result: row.result ? JSON.parse(row.result as string) : null,
      createdAt: new Date(row.created_at as string),
      startedAt: row.started_at ? new Date(row.started_at as string) : null,
      completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
    };
  }
}
