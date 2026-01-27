/**
 * Kronk IPC Client
 *
 * Client for communicating with the Kronk daemon via Unix socket.
 */

import { createConnection, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from './ipc.js';

export interface IPCClientConfig {
  socketPath: string;
  timeout?: number;
}

export interface IPCClientEvents {
  'connect': () => void;
  'disconnect': () => void;
  'notification': (method: string, params: Record<string, unknown>) => void;
  'error': (error: Error) => void;
}

export class IPCClient extends EventEmitter {
  private socket: Socket | null = null;
  private socketPath: string;
  private timeout: number;
  private requestId: number = 0;
  private pendingRequests: Map<string | number, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = new Map();
  private buffer: string = '';
  private connected: boolean = false;

  constructor(config: IPCClientConfig) {
    super();
    this.socketPath = config.socketPath;
    this.timeout = config.timeout ?? 30000;
  }

  /**
   * Type-safe event emitter methods
   */
  override on<K extends keyof IPCClientEvents>(event: K, listener: IPCClientEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof IPCClientEvents>(event: K, ...args: Parameters<IPCClientEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Connect to the daemon
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connected) {
        resolve();
        return;
      }

      this.socket = createConnection(this.socketPath);

      this.socket.on('connect', () => {
        this.connected = true;
        this.emit('connect');
        resolve();
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.emit('disconnect');
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Connection closed'));
        }
        this.pendingRequests.clear();
      });

      this.socket.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          reject(new Error('Daemon is not running. Start it with: kronk start'));
        } else if (error.code === 'ECONNREFUSED') {
          reject(new Error('Connection refused. The daemon may have crashed.'));
        } else {
          reject(error);
        }
        this.emit('error', error);
      });
    });
  }

  /**
   * Disconnect from the daemon
   */
  disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.socket || !this.connected) {
        resolve();
        return;
      }

      this.socket.end(() => {
        this.socket = null;
        this.connected = false;
        resolve();
      });
    });
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Send a request and wait for response
   */
  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to daemon');
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, this.timeout);

      this.pendingRequests.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      this.socket!.write(JSON.stringify(request) + '\n');
    });
  }

  /**
   * Send a notification (no response expected)
   */
  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to daemon');
    }

    const notification: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: null,
      method,
      params,
    };

    this.socket.write(JSON.stringify(notification) + '\n');
  }

  /**
   * Subscribe to daemon events
   */
  async subscribe(events: string[] = ['*']): Promise<void> {
    await this.request('subscribe', { events });
  }

  /**
   * Unsubscribe from daemon events
   */
  async unsubscribe(events?: string[]): Promise<void> {
    await this.request('unsubscribe', { events });
  }

  // Convenience methods for common operations

  /**
   * Run a message through the agent
   */
  async run(message: string): Promise<unknown> {
    return this.request('agent.run', { message });
  }

  /**
   * Get agent status
   */
  async status(): Promise<{
    state: string;
    uptime: number;
    stats: Record<string, unknown>;
  }> {
    return this.request('agent.status');
  }

  /**
   * Store a memory
   */
  async remember(content: string, options?: {
    tier?: 'system2' | 'working' | 'system1';
    tags?: string[];
    importance?: number;
  }): Promise<unknown> {
    return this.request('agent.remember', { content, ...options });
  }

  /**
   * Search memories
   */
  async recall(query: string, limit?: number): Promise<unknown[]> {
    return this.request('agent.recall', { query, limit });
  }

  /**
   * Get recent journal entries
   */
  async journal(limit?: number): Promise<unknown[]> {
    return this.request('journal.recent', { limit });
  }

  /**
   * Get memory statistics
   */
  async memoryStats(): Promise<unknown> {
    return this.request('memory.stats');
  }

  /**
   * Add a task to the queue
   */
  async queueAdd(type: string, payload?: Record<string, unknown>, priority?: number): Promise<unknown> {
    return this.request('queue.add', { type, payload, priority });
  }

  /**
   * List queued tasks
   */
  async queueList(status?: string | string[], limit?: number): Promise<unknown[]> {
    return this.request('queue.list', { status, limit });
  }

  /**
   * Get queue statistics
   */
  async queueStats(): Promise<unknown> {
    return this.request('queue.stats');
  }

  /**
   * Ping the daemon
   */
  async ping(): Promise<{ pong: number }> {
    return this.request('ping');
  }

  /**
   * Request daemon shutdown
   */
  async shutdown(): Promise<void> {
    await this.request('shutdown');
  }

  /**
   * Handle incoming data
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim()) {
        this.handleMessage(line);
      }
    }
  }

  /**
   * Handle a JSON-RPC message
   */
  private handleMessage(message: string): void {
    try {
      const parsed = JSON.parse(message);

      // Check if it's a response or notification
      if ('id' in parsed && parsed.id !== null) {
        // It's a response
        const response = parsed as JsonRpcResponse;
        const id = response.id as string | number;
        const pending = this.pendingRequests.get(id);

        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(id);

          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            pending.resolve(response.result);
          }
        }
      } else if ('method' in parsed) {
        // It's a notification
        const notification = parsed as JsonRpcNotification;
        this.emit('notification', notification.method, notification.params ?? {});
      }
    } catch (error) {
      this.emit('error', new Error(`Failed to parse message: ${message}`));
    }
  }
}

/**
 * Create a client and connect to the daemon
 */
export async function connectToDaemon(socketPath: string): Promise<IPCClient> {
  const client = new IPCClient({ socketPath });
  await client.connect();
  return client;
}

/**
 * Check if the daemon is running
 */
export async function isDaemonRunning(socketPath: string): Promise<boolean> {
  const client = new IPCClient({ socketPath, timeout: 1000 });
  try {
    await client.connect();
    await client.ping();
    await client.disconnect();
    return true;
  } catch {
    return false;
  }
}
