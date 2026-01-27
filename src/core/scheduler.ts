/**
 * Kronk Scheduler
 *
 * Cron-style scheduling for recurring tasks like memory decay,
 * consolidation, cleanup, and custom user-defined schedules.
 */

import cron from 'node-cron';
import { EventEmitter } from 'node:events';
import type { Agent } from './agent.js';
import type { Memory } from '../memory/manager.js';

export interface ScheduledTask {
  id: string;
  name: string;
  schedule: string; // Cron expression
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
  runCount: number;
  handler: () => Promise<void>;
}

export interface SchedulerConfig {
  /** Cron expression for memory decay (default: every hour) */
  memoryDecay?: string;
  /** Cron expression for memory cleanup (default: every hour) */
  memoryCleanup?: string;
  /** Cron expression for memory consolidation (default: daily at midnight) */
  consolidation?: string;
  /** Custom scheduled tasks */
  customTasks?: Array<{
    name: string;
    schedule: string;
    handler: () => Promise<void>;
  }>;
}

export interface SchedulerEvents {
  'task:start': (taskId: string, taskName: string) => void;
  'task:complete': (taskId: string, taskName: string, duration: number) => void;
  'task:error': (taskId: string, taskName: string, error: Error) => void;
  'scheduler:start': () => void;
  'scheduler:stop': () => void;
}

const DEFAULT_SCHEDULES: Required<Pick<SchedulerConfig, 'memoryDecay' | 'memoryCleanup' | 'consolidation'>> = {
  memoryDecay: '0 * * * *',     // Every hour
  memoryCleanup: '0 * * * *',   // Every hour
  consolidation: '0 0 * * *',   // Daily at midnight
};

export class Scheduler extends EventEmitter {
  private agent: Agent;
  private tasks: Map<string, ScheduledTask> = new Map();
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private running: boolean = false;
  private config: SchedulerConfig;
  private summarizer?: (memories: Memory[]) => Promise<string>;

  constructor(agent: Agent, config: SchedulerConfig = {}) {
    super();
    this.agent = agent;
    this.config = config;
  }

  /**
   * Type-safe event emitter methods
   */
  override on<K extends keyof SchedulerEvents>(event: K, listener: SchedulerEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof SchedulerEvents>(event: K, ...args: Parameters<SchedulerEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Set the summarizer function for memory consolidation
   */
  setSummarizer(summarizer: (memories: Memory[]) => Promise<string>): void {
    this.summarizer = summarizer;
  }

  /**
   * Initialize and start all scheduled tasks
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;

    // Register built-in tasks
    this.registerTask({
      id: 'memory-decay',
      name: 'Memory Decay',
      schedule: this.config.memoryDecay ?? DEFAULT_SCHEDULES.memoryDecay,
      enabled: true,
      runCount: 0,
      handler: async () => {
        await this.agent.decayMemories();
      },
    });

    this.registerTask({
      id: 'memory-cleanup',
      name: 'Memory Cleanup',
      schedule: this.config.memoryCleanup ?? DEFAULT_SCHEDULES.memoryCleanup,
      enabled: true,
      runCount: 0,
      handler: async () => {
        const instance = this.agent.getInstance();
        await instance.memory.cleanup();
      },
    });

    this.registerTask({
      id: 'memory-consolidation',
      name: 'Memory Consolidation',
      schedule: this.config.consolidation ?? DEFAULT_SCHEDULES.consolidation,
      enabled: true,
      runCount: 0,
      handler: async () => {
        if (this.summarizer) {
          await this.agent.consolidate(this.summarizer);
        }
      },
    });

    // Register custom tasks
    if (this.config.customTasks) {
      for (const customTask of this.config.customTasks) {
        this.registerTask({
          id: `custom-${customTask.name.toLowerCase().replace(/\s+/g, '-')}`,
          name: customTask.name,
          schedule: customTask.schedule,
          enabled: true,
          runCount: 0,
          handler: customTask.handler,
        });
      }
    }

    // Start all cron jobs
    for (const [id, task] of this.tasks) {
      if (task.enabled) {
        this.startCronJob(id, task);
      }
    }

    this.emit('scheduler:start');
  }

  /**
   * Stop all scheduled tasks
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    for (const [id, job] of this.cronJobs) {
      job.stop();
    }

    this.cronJobs.clear();
    this.running = false;
    this.emit('scheduler:stop');
  }

  /**
   * Check if scheduler is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Register a new scheduled task
   */
  registerTask(task: ScheduledTask): void {
    this.tasks.set(task.id, task);

    if (this.running && task.enabled) {
      this.startCronJob(task.id, task);
    }
  }

  /**
   * Unregister a scheduled task
   */
  unregisterTask(taskId: string): boolean {
    const job = this.cronJobs.get(taskId);
    if (job) {
      job.stop();
      this.cronJobs.delete(taskId);
    }
    return this.tasks.delete(taskId);
  }

  /**
   * Enable a task
   */
  enableTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }

    task.enabled = true;
    if (this.running && !this.cronJobs.has(taskId)) {
      this.startCronJob(taskId, task);
    }
    return true;
  }

  /**
   * Disable a task
   */
  disableTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }

    task.enabled = false;
    const job = this.cronJobs.get(taskId);
    if (job) {
      job.stop();
      this.cronJobs.delete(taskId);
    }
    return true;
  }

  /**
   * Get all registered tasks
   */
  getTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Get a specific task
   */
  getTask(taskId: string): ScheduledTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Manually run a task immediately
   */
  async runTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    await this.executeTask(task);
  }

  /**
   * Update a task's schedule
   */
  updateSchedule(taskId: string, schedule: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }

    if (!cron.validate(schedule)) {
      throw new Error(`Invalid cron expression: ${schedule}`);
    }

    task.schedule = schedule;

    // Restart the cron job with new schedule
    if (this.running && task.enabled) {
      const job = this.cronJobs.get(taskId);
      if (job) {
        job.stop();
      }
      this.startCronJob(taskId, task);
    }

    return true;
  }

  /**
   * Validate a cron expression
   */
  static validateSchedule(schedule: string): boolean {
    return cron.validate(schedule);
  }

  /**
   * Start a cron job for a task
   */
  private startCronJob(taskId: string, task: ScheduledTask): void {
    const job = cron.schedule(task.schedule, async () => {
      await this.executeTask(task);
    });

    this.cronJobs.set(taskId, job);
    task.nextRun = this.getNextRunTime(task.schedule);
  }

  /**
   * Execute a task and emit events
   */
  private async executeTask(task: ScheduledTask): Promise<void> {
    const startTime = Date.now();
    this.emit('task:start', task.id, task.name);

    try {
      await task.handler();
      const duration = Date.now() - startTime;
      task.lastRun = new Date();
      task.runCount++;
      task.nextRun = this.getNextRunTime(task.schedule);
      this.emit('task:complete', task.id, task.name, duration);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('task:error', task.id, task.name, err);
    }
  }

  /**
   * Calculate the next run time for a cron expression
   */
  private getNextRunTime(schedule: string): Date {
    // node-cron doesn't have a built-in way to get next run time,
    // so we'll estimate based on the current time
    // This is a simplified implementation
    return new Date(Date.now() + 60000); // Placeholder, actual next run depends on cron
  }
}
