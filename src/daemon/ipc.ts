/**
 * Kronk IPC Server
 *
 * Unix socket server for daemon communication using JSON-RPC 2.0 protocol.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import type { Agent, RunResult } from '../core/agent.js';
import type { Memory } from '../memory/manager.js';
import type { JournalEntry } from '../journal/manager.js';
import type { QueueManager, QueueTask, TaskStatus } from '../queue/manager.js';
import type { Scheduler } from '../core/scheduler.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface IPCServerConfig {
  socketPath: string;
}

export interface IPCServerEvents {
  'client:connect': (clientId: string) => void;
  'client:disconnect': (clientId: string) => void;
  'request': (method: string, params: unknown, clientId: string) => void;
  'error': (error: Error) => void;
}

// JSON-RPC error codes
const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

export class IPCServer extends EventEmitter {
  private server: Server | null = null;
  private clients: Map<string, Socket> = new Map();
  private socketPath: string;
  private agent: Agent | null = null;
  private queue: QueueManager | null = null;
  private scheduler: Scheduler | null = null;
  private clientIdCounter: number = 0;
  private eventSubscriptions: Map<string, Set<string>> = new Map(); // event -> clientIds

  constructor(config: IPCServerConfig) {
    super();
    this.socketPath = config.socketPath;
  }

  /**
   * Type-safe event emitter methods
   */
  override on<K extends keyof IPCServerEvents>(event: K, listener: IPCServerEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof IPCServerEvents>(event: K, ...args: Parameters<IPCServerEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Set the agent instance for handling commands
   */
  setAgent(agent: Agent): void {
    this.agent = agent;

    // Forward agent events to subscribed clients
    agent.on('state:change', (state, prev) => {
      this.broadcast('agent.state', { state, previousState: prev });
    });

    agent.on('memory:store', (memory) => {
      this.broadcast('agent.memory', { memory });
    });

    agent.on('journal:entry', (entry) => {
      this.broadcast('agent.journal', { entry });
    });

    agent.on('run:start', (message) => {
      this.broadcast('agent.run.start', { message });
    });

    agent.on('run:complete', (result) => {
      this.broadcast('agent.run.complete', { result });
    });

    agent.on('tool:invoke', (name, params, phase, result) => {
      this.broadcast('agent.tool', { name, params, phase, result });
    });
  }

  /**
   * Set the queue manager
   */
  setQueueManager(queue: QueueManager): void {
    this.queue = queue;

    queue.on('task:added', (task) => {
      this.broadcast('queue.task.added', { task });
    });

    queue.on('task:completed', (task, result) => {
      this.broadcast('queue.task.completed', { task, result });
    });

    queue.on('task:failed', (task, error) => {
      this.broadcast('queue.task.failed', { task, error: error.message });
    });
  }

  /**
   * Set the scheduler
   */
  setScheduler(scheduler: Scheduler): void {
    this.scheduler = scheduler;

    scheduler.on('task:start', (taskId, taskName) => {
      this.broadcast('scheduler.task.start', { taskId, taskName });
    });

    scheduler.on('task:complete', (taskId, taskName, duration) => {
      this.broadcast('scheduler.task.complete', { taskId, taskName, duration });
    });
  }

  /**
   * Start the IPC server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          // Try to clean up stale socket
          import('node:fs').then(({ unlinkSync }) => {
            try {
              unlinkSync(this.socketPath);
              this.server?.listen(this.socketPath, () => {
                resolve();
              });
            } catch {
              reject(new Error(`Socket already in use: ${this.socketPath}`));
            }
          });
        } else {
          reject(error);
        }
      });

      this.server.listen(this.socketPath, () => {
        resolve();
      });
    });
  }

  /**
   * Stop the IPC server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all client connections
      for (const [clientId, socket] of this.clients) {
        socket.end();
      }
      this.clients.clear();

      if (this.server) {
        this.server.close(() => {
          this.server = null;
          // Clean up socket file
          import('node:fs').then(({ unlinkSync }) => {
            try {
              unlinkSync(this.socketPath);
            } catch {
              // Ignore if file doesn't exist
            }
            resolve();
          });
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Broadcast a notification to all subscribed clients
   */
  private broadcast(event: string, params: Record<string, unknown>): void {
    const subscribers = this.eventSubscriptions.get(event) ?? this.eventSubscriptions.get('*');
    if (!subscribers) {
      return;
    }

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: event,
      params,
    };

    const message = JSON.stringify(notification) + '\n';

    for (const clientId of subscribers) {
      const socket = this.clients.get(clientId);
      if (socket && !socket.destroyed) {
        socket.write(message);
      }
    }
  }

  /**
   * Handle a new client connection
   */
  private handleConnection(socket: Socket): void {
    const clientId = `client-${++this.clientIdCounter}`;
    this.clients.set(clientId, socket);
    this.emit('client:connect', clientId);

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      // Process complete messages (newline-delimited JSON)
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim()) {
          this.handleMessage(clientId, socket, line);
        }
      }
    });

    socket.on('close', () => {
      this.clients.delete(clientId);
      // Remove from all subscriptions
      for (const [event, subscribers] of this.eventSubscriptions) {
        subscribers.delete(clientId);
      }
      this.emit('client:disconnect', clientId);
    });

    socket.on('error', (error) => {
      this.emit('error', error);
    });
  }

  /**
   * Handle a JSON-RPC message
   */
  private async handleMessage(clientId: string, socket: Socket, message: string): Promise<void> {
    let request: JsonRpcRequest;

    try {
      request = JSON.parse(message);
    } catch {
      this.sendError(socket, null, RPC_ERRORS.PARSE_ERROR, 'Parse error');
      return;
    }

    if (request.jsonrpc !== '2.0' || !request.method) {
      this.sendError(socket, request.id, RPC_ERRORS.INVALID_REQUEST, 'Invalid request');
      return;
    }

    this.emit('request', request.method, request.params, clientId);

    try {
      const result = await this.handleMethod(clientId, request.method, request.params);
      this.sendResult(socket, request.id, result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.sendError(socket, request.id, RPC_ERRORS.INTERNAL_ERROR, err.message);
    }
  }

  /**
   * Handle a specific RPC method
   */
  private async handleMethod(
    clientId: string,
    method: string,
    params?: Record<string, unknown> | unknown[]
  ): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      // Agent methods
      case 'agent.run':
        if (!this.agent) throw new Error('Agent not initialized');
        return this.agent.run(p.message as string);

      case 'agent.status':
        if (!this.agent) throw new Error('Agent not initialized');
        return {
          state: this.agent.getState(),
          uptime: this.agent.getUptime(),
          stats: await this.agent.getStats(),
        };

      case 'agent.remember':
        if (!this.agent) throw new Error('Agent not initialized');
        return this.agent.remember(p.content as string, {
          tier: p.tier as 'system2' | 'working' | 'system1',
          tags: p.tags as string[],
          importance: p.importance as number,
        });

      case 'agent.recall':
        if (!this.agent) throw new Error('Agent not initialized');
        return this.agent.recall(p.query as string, p.limit as number);

      case 'agent.reflect':
        if (!this.agent) throw new Error('Agent not initialized');
        return this.agent.reflect();

      case 'agent.decay':
        if (!this.agent) throw new Error('Agent not initialized');
        return this.agent.decayMemories();

      // Memory methods
      case 'memory.list':
        if (!this.agent) throw new Error('Agent not initialized');
        const instance = this.agent.getInstance();
        return instance.memory.search(p.query as string ?? '', {
          limit: p.limit as number ?? 20,
          tier: p.tier as 'system2' | 'working' | 'system1',
        });

      case 'memory.stats':
        if (!this.agent) throw new Error('Agent not initialized');
        return this.agent.getInstance().memory.getStats();

      // Journal methods
      case 'journal.recent':
        if (!this.agent) throw new Error('Agent not initialized');
        return this.agent.getInstance().journal.getRecent(p.limit as number ?? 20);

      case 'journal.search':
        if (!this.agent) throw new Error('Agent not initialized');
        return this.agent.getInstance().journal.search(p.query as string, {
          limit: p.limit as number ?? 20,
        });

      // Queue methods
      case 'queue.add':
        if (!this.queue) throw new Error('Queue not initialized');
        return this.queue.add({
          type: p.type as string,
          payload: p.payload as Record<string, unknown>,
          priority: p.priority as number,
        });

      case 'queue.list':
        if (!this.queue) throw new Error('Queue not initialized');
        return this.queue.list({
          status: p.status as TaskStatus | TaskStatus[] | undefined,
          limit: p.limit as number,
        });

      case 'queue.cancel':
        if (!this.queue) throw new Error('Queue not initialized');
        return this.queue.cancel(p.id as string);

      case 'queue.stats':
        if (!this.queue) throw new Error('Queue not initialized');
        return this.queue.getStats();

      // Scheduler methods
      case 'scheduler.tasks':
        if (!this.scheduler) throw new Error('Scheduler not initialized');
        return this.scheduler.getTasks();

      case 'scheduler.run':
        if (!this.scheduler) throw new Error('Scheduler not initialized');
        await this.scheduler.runTask(p.taskId as string);
        return { success: true };

      // Subscription methods
      case 'subscribe':
        const events = (p.events as string[]) ?? ['*'];
        for (const event of events) {
          if (!this.eventSubscriptions.has(event)) {
            this.eventSubscriptions.set(event, new Set());
          }
          this.eventSubscriptions.get(event)!.add(clientId);
        }
        return { subscribed: events };

      case 'unsubscribe':
        const unsubEvents = (p.events as string[]) ?? Array.from(this.eventSubscriptions.keys());
        for (const event of unsubEvents) {
          this.eventSubscriptions.get(event)?.delete(clientId);
        }
        return { unsubscribed: unsubEvents };

      // System methods
      case 'ping':
        return { pong: Date.now() };

      case 'shutdown':
        // Schedule shutdown
        setTimeout(() => process.exit(0), 100);
        return { shutting_down: true };

      default:
        throw new Error(`Method not found: ${method}`);
    }
  }

  /**
   * Send a successful result
   */
  private sendResult(socket: Socket, id: string | number | null, result: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    socket.write(JSON.stringify(response) + '\n');
  }

  /**
   * Send an error response
   */
  private sendError(
    socket: Socket,
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown
  ): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message, data },
    };
    socket.write(JSON.stringify(response) + '\n');
  }
}
