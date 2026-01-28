/**
 * Kronk Daemon Manager
 *
 * Background process orchestration with PID management,
 * graceful shutdown, and health checks.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, unlink, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { IPCServer } from './ipc.js';
import { IPCClient, isDaemonRunning } from './client.js';
import { Agent, type AgentOptions } from '../core/agent.js';
import { Scheduler, type SchedulerConfig } from '../core/scheduler.js';
import { QueueManager, type QueueManagerConfig } from '../queue/manager.js';
import { load, type KronkInstance } from '../init/index.js';

export interface DaemonConfig {
  /** Path to the .kronk directory */
  kronkPath: string;
  /** Socket path for IPC */
  socketPath?: string;
  /** PID file path */
  pidFile?: string;
  /** Auto-restart on crash */
  autoRestart?: boolean;
  /** Maximum restart attempts */
  maxRestarts?: number;
  /** Restart delay in ms */
  restartDelay?: number;
  /** Scheduler configuration */
  scheduler?: SchedulerConfig;
  /** Queue configuration */
  queue?: QueueManagerConfig;
}

export interface DaemonStatus {
  running: boolean;
  pid?: number;
  uptime?: number;
  socketPath?: string;
}

export interface DaemonEvents {
  'start': () => void;
  'stop': () => void;
  'restart': (attempt: number) => void;
  'error': (error: Error) => void;
}

const DEFAULT_SOCKET_NAME = 'kronk.sock';
const DEFAULT_PID_NAME = 'kronk.pid';

export class Daemon extends EventEmitter {
  private config: DaemonConfig;
  private socketPath: string;
  private pidFile: string;
  private instance: KronkInstance | null = null;
  private agent: Agent | null = null;
  private scheduler: Scheduler | null = null;
  private queue: QueueManager | null = null;
  private ipcServer: IPCServer | null = null;
  private startTime: number = 0;
  private running: boolean = false;

  constructor(config: DaemonConfig) {
    super();
    this.config = config;
    this.socketPath = config.socketPath ?? join(config.kronkPath, DEFAULT_SOCKET_NAME);
    this.pidFile = config.pidFile ?? join(config.kronkPath, DEFAULT_PID_NAME);
  }

  /**
   * Type-safe event emitter methods
   */
  override on<K extends keyof DaemonEvents>(event: K, listener: DaemonEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof DaemonEvents>(event: K, ...args: Parameters<DaemonEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Start the daemon in the current process
   */
  async start(agentOptions: Omit<AgentOptions, 'llm' | 'embedder'> & {
    llm: AgentOptions['llm'];
    embedder?: AgentOptions['embedder'];
  }): Promise<void> {
    if (this.running) {
      throw new Error('Daemon is already running');
    }

    // Check if another daemon is running
    if (await isDaemonRunning(this.socketPath)) {
      throw new Error('Another daemon is already running');
    }

    // Load kronk instance
    this.instance = await load(this.config.kronkPath.replace('/.kronk', ''));

    // Create agent
    this.agent = new Agent(this.instance, agentOptions);
    await this.agent.initialize();

    // Create scheduler
    this.scheduler = new Scheduler(this.agent, this.config.scheduler);

    // Create queue manager
    this.queue = new QueueManager(this.instance.db, this.config.queue);

    // Create and start IPC server
    this.ipcServer = new IPCServer({ socketPath: this.socketPath });
    this.ipcServer.setAgent(this.agent);
    this.ipcServer.setQueueManager(this.queue);
    this.ipcServer.setScheduler(this.scheduler);

    await this.ipcServer.start();

    // Start scheduler and queue
    this.scheduler.start();
    this.queue.start();

    // Write PID file
    await this.writePidFile();

    // Set up signal handlers
    this.setupSignalHandlers();

    this.startTime = Date.now();
    this.running = true;
    this.emit('start');
  }

  /**
   * Stop the daemon
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;

    // Stop scheduler and queue
    this.scheduler?.stop();
    this.queue?.stop();

    // Stop IPC server
    if (this.ipcServer) {
      await this.ipcServer.stop();
    }

    // Close database connection
    if (this.instance) {
      await this.instance.db.close();
    }

    // Remove PID file
    await this.removePidFile();

    this.emit('stop');
  }

  /**
   * Get daemon status
   */
  async getStatus(): Promise<DaemonStatus> {
    const pid = await this.readPidFile();
    const running = pid !== null && await this.isProcessRunning(pid);

    return {
      running,
      pid: pid ?? undefined,
      uptime: running && this.startTime > 0 ? Date.now() - this.startTime : undefined,
      socketPath: this.socketPath,
    };
  }

  /**
   * Check if the daemon is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the socket path
   */
  getSocketPath(): string {
    return this.socketPath;
  }

  /**
   * Get the agent instance
   */
  getAgent(): Agent | null {
    return this.agent;
  }

  /**
   * Get the scheduler instance
   */
  getScheduler(): Scheduler | null {
    return this.scheduler;
  }

  /**
   * Get the queue manager instance
   */
  getQueueManager(): QueueManager | null {
    return this.queue;
  }

  /**
   * Write the PID file
   */
  private async writePidFile(): Promise<void> {
    await writeFile(this.pidFile, String(process.pid), 'utf-8');
  }

  /**
   * Remove the PID file
   */
  private async removePidFile(): Promise<void> {
    try {
      await unlink(this.pidFile);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  /**
   * Read the PID from the PID file
   */
  private async readPidFile(): Promise<number | null> {
    try {
      const content = await readFile(this.pidFile, 'utf-8');
      const pid = parseInt(content.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  /**
   * Check if a process is running
   */
  private async isProcessRunning(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Set up signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const shutdown = async (signal: string) => {
      console.log(`\nReceived ${signal}, shutting down...`);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}

/**
 * Start the daemon in a detached background process
 */
export async function startDaemonProcess(
  kronkPath: string,
  options: {
    logFile?: string;
  } = {}
): Promise<{ pid: number; socketPath: string }> {
  const socketPath = join(kronkPath, DEFAULT_SOCKET_NAME);
  const pidFile = join(kronkPath, DEFAULT_PID_NAME);

  // Check if daemon is already running
  if (await isDaemonRunning(socketPath)) {
    const pid = await readFile(pidFile, 'utf-8').then(c => parseInt(c.trim(), 10)).catch(() => 0);
    return { pid, socketPath };
  }

  // Find the daemon entry script
  const daemonScript = join(kronkPath, '..', 'node_modules', 'kronk', 'dist', 'daemon-entry.js');

  // Spawn detached process
  const child = spawn(process.execPath, [daemonScript, kronkPath], {
    detached: true,
    stdio: 'ignore',
    cwd: kronkPath.replace('/.kronk', ''),
    env: {
      ...process.env,
      KRONK_DAEMON: '1',
      KRONK_PATH: kronkPath,
    },
  });

  child.unref();

  // Wait for daemon to start
  let attempts = 0;
  while (attempts < 50) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (await isDaemonRunning(socketPath)) {
      const pid = child.pid ?? 0;
      return { pid, socketPath };
    }
    attempts++;
  }

  throw new Error('Daemon failed to start within timeout');
}

/**
 * Stop a running daemon
 */
export async function stopDaemon(kronkPath: string): Promise<boolean> {
  const socketPath = join(kronkPath, DEFAULT_SOCKET_NAME);
  const pidFile = join(kronkPath, DEFAULT_PID_NAME);

  if (!(await isDaemonRunning(socketPath))) {
    // Try to clean up stale PID file
    try {
      await unlink(pidFile);
    } catch {}
    return false;
  }

  // Connect and request shutdown
  const client = new IPCClient({ socketPath, timeout: 5000 });
  try {
    await client.connect();
    await client.shutdown();
    await client.disconnect();

    // Wait for daemon to stop
    let attempts = 0;
    while (attempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!(await isDaemonRunning(socketPath))) {
        return true;
      }
      attempts++;
    }

    // Force kill if still running
    const pidContent = await readFile(pidFile, 'utf-8').catch(() => '');
    const pid = parseInt(pidContent.trim(), 10);
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }

    return true;
  } catch (error) {
    // Try to kill by PID
    const pidContent = await readFile(pidFile, 'utf-8').catch(() => '');
    const pid = parseInt(pidContent.trim(), 10);
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        return true;
      } catch {}
    }
    return false;
  }
}

/**
 * Get daemon status
 */
export async function getDaemonStatus(kronkPath: string): Promise<DaemonStatus> {
  const socketPath = join(kronkPath, DEFAULT_SOCKET_NAME);
  const pidFile = join(kronkPath, DEFAULT_PID_NAME);

  const running = await isDaemonRunning(socketPath);

  let pid: number | undefined;
  try {
    const pidContent = await readFile(pidFile, 'utf-8');
    pid = parseInt(pidContent.trim(), 10);
  } catch {}

  return {
    running,
    pid,
    socketPath,
  };
}

/**
 * Check if a path exists
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
