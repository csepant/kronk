/**
 * Kronk File System Watcher
 *
 * Directory monitoring with configurable triggers using chokidar.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import type { KronkDatabase } from '../db/client.js';
import type { Agent } from '../core/agent.js';
import type { QueueManager } from '../queue/manager.js';

export type WatcherAction = 'run' | 'memory' | 'queue';
export type WatcherEventType = 'add' | 'change' | 'unlink';

export interface Watcher {
  id: string;
  pattern: string;
  action: WatcherAction;
  actionConfig: WatcherActionConfig | null;
  enabled: boolean;
  debounceMs: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WatcherActionConfig {
  /** For 'run' action: message template (supports {path}, {event}, {basename}) */
  message?: string;
  /** For 'memory' action: tier to store in */
  tier?: 'system2' | 'working' | 'system1';
  /** For 'memory' action: importance score */
  importance?: number;
  /** For 'memory' action: tags */
  tags?: string[];
  /** For 'queue' action: task type */
  taskType?: string;
  /** For 'queue' action: priority */
  priority?: number;
}

export interface WatcherInput {
  pattern: string;
  action: WatcherAction;
  actionConfig?: WatcherActionConfig;
  debounceMs?: number;
}

export interface FileWatcherEvents {
  'file:change': (path: string, event: WatcherEventType, watcherId: string) => void;
  'action:triggered': (watcherId: string, action: WatcherAction, path: string) => void;
  'action:completed': (watcherId: string, action: WatcherAction, path: string, result: unknown) => void;
  'action:error': (watcherId: string, action: WatcherAction, path: string, error: Error) => void;
  'watcher:added': (watcher: Watcher) => void;
  'watcher:removed': (watcherId: string) => void;
  'error': (error: Error) => void;
}

export interface FileWatcherConfig {
  /** Base path for relative patterns */
  basePath?: string;
  /** Whether to use polling (for network mounts) */
  usePolling?: boolean;
  /** Polling interval in ms */
  pollInterval?: number;
  /** Ignore dotfiles */
  ignoreDotFiles?: boolean;
}

export class FileWatcher extends EventEmitter {
  private db: KronkDatabase;
  private agent: Agent | null = null;
  private queue: QueueManager | null = null;
  private config: FileWatcherConfig;
  private watchers: Map<string, Watcher> = new Map();
  private chokidarWatchers: Map<string, FSWatcher> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private running: boolean = false;

  constructor(db: KronkDatabase, config: FileWatcherConfig = {}) {
    super();
    this.db = db;
    this.config = config;
  }

  /**
   * Type-safe event emitter methods
   */
  override on<K extends keyof FileWatcherEvents>(event: K, listener: FileWatcherEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof FileWatcherEvents>(event: K, ...args: Parameters<FileWatcherEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Set the agent for 'run' and 'memory' actions
   */
  setAgent(agent: Agent): void {
    this.agent = agent;
  }

  /**
   * Set the queue manager for 'queue' actions
   */
  setQueueManager(queue: QueueManager): void {
    this.queue = queue;
  }

  /**
   * Add a new watcher
   */
  async add(input: WatcherInput): Promise<Watcher> {
    const result = await this.db.query(
      `INSERT INTO watchers (pattern, action, action_config, debounce_ms)
       VALUES (?, ?, ?, ?)
       RETURNING *`,
      [
        input.pattern,
        input.action,
        input.actionConfig ? JSON.stringify(input.actionConfig) : null,
        input.debounceMs ?? 500,
      ]
    );

    const watcher = this.rowToWatcher(result.rows[0]);
    this.watchers.set(watcher.id, watcher);

    if (this.running && watcher.enabled) {
      this.startWatcher(watcher);
    }

    this.emit('watcher:added', watcher);
    return watcher;
  }

  /**
   * Get a watcher by ID
   */
  async get(id: string): Promise<Watcher | null> {
    const watcher = this.watchers.get(id);
    if (watcher) {
      return watcher;
    }

    const result = await this.db.query(
      'SELECT * FROM watchers WHERE id = ?',
      [id]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToWatcher(result.rows[0]);
  }

  /**
   * List all watchers
   */
  async list(onlyEnabled: boolean = false): Promise<Watcher[]> {
    let query = 'SELECT * FROM watchers';
    if (onlyEnabled) {
      query += ' WHERE enabled = 1';
    }
    query += ' ORDER BY created_at DESC';

    const result = await this.db.query(query);
    return result.rows.map(row => this.rowToWatcher(row));
  }

  /**
   * Remove a watcher
   */
  async remove(id: string): Promise<boolean> {
    // Stop the chokidar watcher
    this.stopWatcher(id);

    const result = await this.db.query(
      'DELETE FROM watchers WHERE id = ?',
      [id]
    );

    if (result.rowsAffected > 0) {
      this.watchers.delete(id);
      this.emit('watcher:removed', id);
      return true;
    }

    return false;
  }

  /**
   * Enable a watcher
   */
  async enable(id: string): Promise<boolean> {
    await this.db.query(
      `UPDATE watchers SET enabled = 1, updated_at = datetime('now') WHERE id = ?`,
      [id]
    );

    const watcher = await this.get(id);
    if (watcher) {
      watcher.enabled = true;
      this.watchers.set(id, watcher);
      if (this.running) {
        this.startWatcher(watcher);
      }
      return true;
    }

    return false;
  }

  /**
   * Disable a watcher
   */
  async disable(id: string): Promise<boolean> {
    await this.db.query(
      `UPDATE watchers SET enabled = 0, updated_at = datetime('now') WHERE id = ?`,
      [id]
    );

    const watcher = this.watchers.get(id);
    if (watcher) {
      watcher.enabled = false;
      this.stopWatcher(id);
      return true;
    }

    return false;
  }

  /**
   * Start all watchers
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    // Load all watchers from database
    const watcherList = await this.list(true);
    for (const watcher of watcherList) {
      this.watchers.set(watcher.id, watcher);
      this.startWatcher(watcher);
    }
  }

  /**
   * Stop all watchers
   */
  async stop(): Promise<void> {
    this.running = false;

    for (const [id] of this.chokidarWatchers) {
      this.stopWatcher(id);
    }

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Start a single watcher
   */
  private startWatcher(watcher: Watcher): void {
    if (this.chokidarWatchers.has(watcher.id)) {
      return;
    }

    const pattern = this.config.basePath
      ? `${this.config.basePath}/${watcher.pattern}`
      : watcher.pattern;

    const chokidarWatcher = chokidar.watch(pattern, {
      persistent: true,
      ignoreInitial: true,
      usePolling: this.config.usePolling,
      interval: this.config.pollInterval,
      ignored: this.config.ignoreDotFiles ? /(^|[\/\\])\../ : undefined,
    });

    chokidarWatcher.on('add', (path) => this.handleEvent(watcher, path, 'add'));
    chokidarWatcher.on('change', (path) => this.handleEvent(watcher, path, 'change'));
    chokidarWatcher.on('unlink', (path) => this.handleEvent(watcher, path, 'unlink'));
    chokidarWatcher.on('error', (error) => this.emit('error', error));

    this.chokidarWatchers.set(watcher.id, chokidarWatcher);
  }

  /**
   * Stop a single watcher
   */
  private stopWatcher(id: string): void {
    const chokidarWatcher = this.chokidarWatchers.get(id);
    if (chokidarWatcher) {
      chokidarWatcher.close();
      this.chokidarWatchers.delete(id);
    }

    const timer = this.debounceTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(id);
    }
  }

  /**
   * Handle a file system event
   */
  private handleEvent(watcher: Watcher, path: string, eventType: WatcherEventType): void {
    this.emit('file:change', path, eventType, watcher.id);

    // Debounce the action
    const key = `${watcher.id}:${path}`;
    const existingTimer = this.debounceTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.executeAction(watcher, path, eventType);
    }, watcher.debounceMs);

    this.debounceTimers.set(key, timer);
  }

  /**
   * Execute the watcher's action
   */
  private async executeAction(watcher: Watcher, path: string, eventType: WatcherEventType): Promise<void> {
    this.emit('action:triggered', watcher.id, watcher.action, path);

    try {
      let result: unknown;

      switch (watcher.action) {
        case 'run':
          result = await this.executeRunAction(watcher, path, eventType);
          break;
        case 'memory':
          result = await this.executeMemoryAction(watcher, path, eventType);
          break;
        case 'queue':
          result = await this.executeQueueAction(watcher, path, eventType);
          break;
      }

      this.emit('action:completed', watcher.id, watcher.action, path, result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('action:error', watcher.id, watcher.action, path, err);
    }
  }

  /**
   * Execute a 'run' action
   */
  private async executeRunAction(watcher: Watcher, path: string, eventType: WatcherEventType): Promise<unknown> {
    if (!this.agent) {
      throw new Error('Agent not set for run action');
    }

    const config = watcher.actionConfig ?? {};
    const basename = path.split('/').pop() ?? path;

    let message = config.message ?? `File ${eventType}: ${path}`;
    message = message
      .replace('{path}', path)
      .replace('{event}', eventType)
      .replace('{basename}', basename);

    return this.agent.run(message);
  }

  /**
   * Execute a 'memory' action
   */
  private async executeMemoryAction(watcher: Watcher, path: string, eventType: WatcherEventType): Promise<unknown> {
    if (!this.agent) {
      throw new Error('Agent not set for memory action');
    }

    const config = watcher.actionConfig ?? {};
    const content = `File ${eventType}: ${path}`;

    return this.agent.remember(content, {
      tier: config.tier ?? 'working',
      importance: config.importance,
      tags: config.tags ?? ['file-watcher', eventType],
    });
  }

  /**
   * Execute a 'queue' action
   */
  private async executeQueueAction(watcher: Watcher, path: string, eventType: WatcherEventType): Promise<unknown> {
    if (!this.queue) {
      throw new Error('Queue manager not set for queue action');
    }

    const config = watcher.actionConfig ?? {};

    return this.queue.add({
      type: config.taskType ?? 'file-watch',
      payload: { path, event: eventType, watcherId: watcher.id },
      priority: config.priority,
    });
  }

  /**
   * Convert a database row to a Watcher
   */
  private rowToWatcher(row: Record<string, unknown>): Watcher {
    return {
      id: row.id as string,
      pattern: row.pattern as string,
      action: row.action as WatcherAction,
      actionConfig: row.action_config ? JSON.parse(row.action_config as string) : null,
      enabled: Boolean(row.enabled),
      debounceMs: row.debounce_ms as number,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}
