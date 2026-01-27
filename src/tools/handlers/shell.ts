/**
 * Shell Tool Handler
 *
 * Executes shell commands and returns stdout/stderr/exit code.
 * Requires user confirmation before execution for security.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ToolSchema, ToolHandler } from '../manager.js';

export const shellToolSchema: ToolSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'Shell command to execute',
    },
    cwd: {
      type: 'string',
      description: 'Working directory (defaults to project root)',
    },
    timeout: {
      type: 'number',
      description: 'Timeout in ms (default: 30000, max: 300000)',
    },
  },
  required: ['command'],
};

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
}

export interface ShellConfirmEvent {
  command: string;
  cwd: string;
  resolve: (approved: boolean) => void;
}

const MAX_TIMEOUT = 300000; // 5 minutes
const DEFAULT_TIMEOUT = 30000; // 30 seconds
const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB

/**
 * Create a shell tool handler with confirmation support
 */
export function createShellHandler(
  emitter: EventEmitter,
  defaultCwd?: string
): ToolHandler {
  return async (params: Record<string, unknown>): Promise<ShellResult> => {
    const command = params.command as string;
    const cwd = (params.cwd as string) || defaultCwd || process.cwd();
    const timeout = Math.min(
      (params.timeout as number) || DEFAULT_TIMEOUT,
      MAX_TIMEOUT
    );

    // Request confirmation via event
    const approved = await new Promise<boolean>((resolve) => {
      const hasListeners = emitter.emit('shell:confirm', {
        command,
        cwd,
        resolve,
      } as ShellConfirmEvent);

      // If no listeners registered, block by default for security
      if (!hasListeners) {
        resolve(false);
      }
    });

    if (!approved) {
      return {
        stdout: '',
        stderr: 'Command execution blocked: user confirmation required',
        exitCode: -1,
        killed: false,
      };
    }

    return executeCommand(command, cwd, timeout);
  };
}

/**
 * Execute a shell command with timeout and output buffering
 */
function executeCommand(
  command: string,
  cwd: string,
  timeout: number
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const { signal } = controller;

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timeoutId = setTimeout(() => {
      killed = true;
      controller.abort();
    }, timeout);

    const child = spawn(command, [], {
      shell: true,
      cwd,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (data: Buffer) => {
      if (stdout.length < MAX_OUTPUT_SIZE) {
        stdout += data.toString();
        if (stdout.length > MAX_OUTPUT_SIZE) {
          stdout = stdout.slice(0, MAX_OUTPUT_SIZE) + '\n... [output truncated]';
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      if (stderr.length < MAX_OUTPUT_SIZE) {
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT_SIZE) {
          stderr = stderr.slice(0, MAX_OUTPUT_SIZE) + '\n... [output truncated]';
        }
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeoutId);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? (killed ? -1 : 0),
        killed,
      });
    });

    child.on('error', (error) => {
      clearTimeout(timeoutId);
      resolve({
        stdout,
        stderr: error.message,
        exitCode: -1,
        killed: signal.aborted,
      });
    });
  });
}
