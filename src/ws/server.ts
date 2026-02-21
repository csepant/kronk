/**
 * Kronk WebSocket Server
 *
 * WebSocket server for browser/remote client communication using JSON-RPC 2.0 protocol.
 * Mirrors the IPC server functionality with additional thinking event streaming
 * and interactive shell confirmation support.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Server, ServerWebSocket } from 'bun';
import type { Agent } from '../core/agent.js';
import type { QueueManager, TaskStatus } from '../queue/manager.js';
import type { Scheduler } from '../core/scheduler.js';
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from '../daemon/ipc.js';

export interface WSServerConfig {
  port: number;
  hostname?: string;
  allowedOrigins?: string[];
}

export interface WSConnectionData {
  clientId: string;
  subscriptions: Set<string>;
  pendingConfirms: Map<string, { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }>;
}

export interface WSServerEvents {
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

export class WSServer extends EventEmitter {
  private server: Server<WSConnectionData> | null = null;
  private clients: Map<string, ServerWebSocket<WSConnectionData>> = new Map();
  private config: WSServerConfig;
  private agent: Agent | null = null;
  private queue: QueueManager | null = null;
  private scheduler: Scheduler | null = null;
  private clientIdCounter: number = 0;
  private eventSubscriptions: Map<string, Set<string>> = new Map(); // event -> clientIds

  constructor(config: WSServerConfig) {
    super();
    this.config = config;
  }

  /**
   * Type-safe event emitter methods
   */
  override on<K extends keyof WSServerEvents>(event: K, listener: WSServerEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof WSServerEvents>(event: K, ...args: Parameters<WSServerEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Set the agent instance for handling commands
   */
  setAgent(agent: Agent): void {
    this.agent = agent;

    // Forward agent events to subscribed clients (same as IPC)
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

    // Thinking events (new, not in IPC)
    agent.on('thinking:start', () => {
      this.broadcast('agent.thinking.start', {});
    });

    agent.on('thinking:chunk', (chunk, accumulated) => {
      this.broadcast('agent.thinking.chunk', { chunk, accumulated });
    });

    agent.on('thinking:complete', (fullThought, tokensUsed) => {
      this.broadcast('agent.thinking.complete', { fullThought, tokensUsed });
    });

    // Shell confirmations — broadcast to subscribed clients and wait for response
    agent.on('shell:confirm', (event) => {
      const confirmId = randomUUID();
      const CONFIRM_TIMEOUT_MS = 30_000;

      // Find clients subscribed to shell.confirm.request or *
      const subscribedClients = this.getSubscribedClients('shell.confirm.request');

      if (subscribedClients.length === 0) {
        // No clients subscribed — auto-reject
        event.resolve(false);
        return;
      }

      // Store the pending confirm in each subscribed client's data
      const timer = setTimeout(() => {
        // Auto-reject on timeout
        for (const ws of subscribedClients) {
          ws.data.pendingConfirms.delete(confirmId);
        }
        event.resolve(false);
      }, CONFIRM_TIMEOUT_MS);

      for (const ws of subscribedClients) {
        ws.data.pendingConfirms.set(confirmId, { resolve: event.resolve, timer });
      }

      // Broadcast the confirmation request
      this.broadcast('shell.confirm.request', {
        id: confirmId,
        command: event.command,
        cwd: event.cwd,
      });
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
   * Start the WebSocket server
   */
  async start(): Promise<void> {
    const self = this;

    this.server = Bun.serve<WSConnectionData>({
      port: this.config.port,
      hostname: this.config.hostname ?? 'localhost',

      fetch(req, server) {
        // Validate Origin if allowedOrigins is configured
        if (self.config.allowedOrigins && self.config.allowedOrigins.length > 0) {
          const origin = req.headers.get('origin');
          if (origin && !self.config.allowedOrigins.includes(origin)) {
            return new Response('Forbidden: Origin not allowed', { status: 403 });
          }
        }

        const clientId = `ws-${++self.clientIdCounter}`;
        const upgraded = server.upgrade(req, {
          data: {
            clientId,
            subscriptions: new Set<string>(),
            pendingConfirms: new Map(),
          },
        });

        if (!upgraded) {
          return new Response('WebSocket upgrade failed', { status: 400 });
        }
      },

      websocket: {
        open(ws) {
          self.clients.set(ws.data.clientId, ws);
          self.emit('client:connect', ws.data.clientId);
        },

        message(ws, message) {
          const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
          self.handleMessage(ws, raw);
        },

        close(ws) {
          const { clientId, pendingConfirms } = ws.data;

          // Reject all pending shell confirms for this client
          for (const [, pending] of pendingConfirms) {
            clearTimeout(pending.timer);
            pending.resolve(false);
          }
          pendingConfirms.clear();

          // Remove from all subscriptions
          for (const [, subscribers] of self.eventSubscriptions) {
            subscribers.delete(clientId);
          }

          self.clients.delete(clientId);
          self.emit('client:disconnect', clientId);
        },
      },
    });
  }

  /**
   * Stop the WebSocket server
   */
  async stop(): Promise<void> {
    // Close all client connections
    for (const [, ws] of this.clients) {
      // Reject pending confirms
      for (const [, pending] of ws.data.pendingConfirms) {
        clearTimeout(pending.timer);
        pending.resolve(false);
      }
      ws.close();
    }
    this.clients.clear();
    this.eventSubscriptions.clear();

    if (this.server) {
      this.server.stop();
      this.server = null;
    }
  }

  /**
   * Get the server port
   */
  getPort(): number {
    return this.config.port;
  }

  /**
   * Get the server hostname
   */
  getHostname(): string {
    return this.config.hostname ?? 'localhost';
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

    const message = JSON.stringify(notification);

    for (const clientId of subscribers) {
      const ws = this.clients.get(clientId);
      if (ws) {
        ws.send(message);
      }
    }
  }

  /**
   * Get all WebSocket clients subscribed to a given event
   */
  private getSubscribedClients(event: string): ServerWebSocket<WSConnectionData>[] {
    const result: ServerWebSocket<WSConnectionData>[] = [];
    const subscribers = new Set<string>();

    // Collect from exact event match and wildcard
    for (const clientId of this.eventSubscriptions.get(event) ?? []) {
      subscribers.add(clientId);
    }
    for (const clientId of this.eventSubscriptions.get('*') ?? []) {
      subscribers.add(clientId);
    }

    for (const clientId of subscribers) {
      const ws = this.clients.get(clientId);
      if (ws) {
        result.push(ws);
      }
    }

    return result;
  }

  /**
   * Handle a JSON-RPC message from a WebSocket client
   */
  private async handleMessage(ws: ServerWebSocket<WSConnectionData>, raw: string): Promise<void> {
    let request: JsonRpcRequest;

    try {
      request = JSON.parse(raw);
    } catch {
      this.sendError(ws, null, RPC_ERRORS.PARSE_ERROR, 'Parse error');
      return;
    }

    if (request.jsonrpc !== '2.0' || !request.method) {
      this.sendError(ws, request.id, RPC_ERRORS.INVALID_REQUEST, 'Invalid request');
      return;
    }

    this.emit('request', request.method, request.params, ws.data.clientId);

    try {
      const result = await this.handleMethod(ws, request.method, request.params);
      this.sendResult(ws, request.id, result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.sendError(ws, request.id, RPC_ERRORS.INTERNAL_ERROR, err.message);
    }
  }

  /**
   * Handle a specific RPC method
   */
  private async handleMethod(
    ws: ServerWebSocket<WSConnectionData>,
    method: string,
    params?: Record<string, unknown> | unknown[]
  ): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    const clientId = ws.data.clientId;

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
      case 'memory.list': {
        if (!this.agent) throw new Error('Agent not initialized');
        const instance = this.agent.getInstance();
        return instance.memory.search(p.query as string ?? '', {
          limit: p.limit as number ?? 20,
          tier: p.tier as 'system2' | 'working' | 'system1',
        });
      }

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
      case 'subscribe': {
        const events = (p.events as string[]) ?? ['*'];
        for (const event of events) {
          if (!this.eventSubscriptions.has(event)) {
            this.eventSubscriptions.set(event, new Set());
          }
          this.eventSubscriptions.get(event)!.add(clientId);
        }
        return { subscribed: events };
      }

      case 'unsubscribe': {
        const unsubEvents = (p.events as string[]) ?? Array.from(this.eventSubscriptions.keys());
        for (const event of unsubEvents) {
          this.eventSubscriptions.get(event)?.delete(clientId);
        }
        return { unsubscribed: unsubEvents };
      }

      // Shell confirmation response
      case 'shell.confirm.respond': {
        const confirmId = p.id as string;
        const approved = p.approved as boolean;
        const pending = ws.data.pendingConfirms.get(confirmId);

        if (!pending) {
          throw new Error(`No pending confirmation found: ${confirmId}`);
        }

        clearTimeout(pending.timer);

        // Remove from all clients' pending maps
        for (const [, client] of this.clients) {
          client.data.pendingConfirms.delete(confirmId);
        }

        pending.resolve(approved);
        return { confirmed: confirmId, approved };
      }

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
  private sendResult(ws: ServerWebSocket<WSConnectionData>, id: string | number | null, result: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    ws.send(JSON.stringify(response));
  }

  /**
   * Send an error response
   */
  private sendError(
    ws: ServerWebSocket<WSConnectionData>,
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
    ws.send(JSON.stringify(response));
  }
}
