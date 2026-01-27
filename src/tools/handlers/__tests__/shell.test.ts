/**
 * Shell Tool Handler Tests
 */

import { describe, test, expect, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createShellHandler, type ShellConfirmEvent } from '../shell.js';

describe('Shell Tool Handler', () => {
  test('executes command when confirmed', async () => {
    const emitter = new EventEmitter();

    // Auto-approve shell commands
    emitter.on('shell:confirm', (event: ShellConfirmEvent) => {
      event.resolve(true);
    });

    const handler = createShellHandler(emitter);
    const result = await handler({ command: 'echo "hello world"' });

    expect(result).toEqual({
      stdout: 'hello world\n',
      stderr: '',
      exitCode: 0,
      killed: false,
    });
  });

  test('blocks command when not confirmed', async () => {
    const emitter = new EventEmitter();

    // Reject shell commands
    emitter.on('shell:confirm', (event: ShellConfirmEvent) => {
      event.resolve(false);
    });

    const handler = createShellHandler(emitter);
    const result = await handler({ command: 'echo "should not run"' });

    expect(result).toEqual({
      stdout: '',
      stderr: 'Command execution blocked: user confirmation required',
      exitCode: -1,
      killed: false,
    });
  });

  test('blocks command when no confirmation handler registered', async () => {
    const emitter = new EventEmitter();
    // No handler registered

    const handler = createShellHandler(emitter);
    const result = await handler({ command: 'echo "no handler"' });

    expect(result).toEqual({
      stdout: '',
      stderr: 'Command execution blocked: user confirmation required',
      exitCode: -1,
      killed: false,
    });
  });

  test('respects timeout parameter', async () => {
    const emitter = new EventEmitter();

    emitter.on('shell:confirm', (event: ShellConfirmEvent) => {
      event.resolve(true);
    });

    const handler = createShellHandler(emitter);
    const result = await handler({
      command: 'sleep 10',
      timeout: 100, // 100ms timeout
    });

    expect(result.killed).toBe(true);
    expect(result.exitCode).toBe(-1);
  });

  test('captures stderr', async () => {
    const emitter = new EventEmitter();

    emitter.on('shell:confirm', (event: ShellConfirmEvent) => {
      event.resolve(true);
    });

    const handler = createShellHandler(emitter);
    const result = await handler({ command: 'echo "error" >&2' });

    expect(result.stderr).toBe('error\n');
    expect(result.exitCode).toBe(0);
  });

  test('returns non-zero exit code for failed commands', async () => {
    const emitter = new EventEmitter();

    emitter.on('shell:confirm', (event: ShellConfirmEvent) => {
      event.resolve(true);
    });

    const handler = createShellHandler(emitter);
    const result = await handler({ command: 'exit 42' });

    expect(result.exitCode).toBe(42);
    expect(result.killed).toBe(false);
  });

  test('uses custom working directory', async () => {
    const emitter = new EventEmitter();

    emitter.on('shell:confirm', (event: ShellConfirmEvent) => {
      expect(event.cwd).toBe('/tmp');
      event.resolve(true);
    });

    const handler = createShellHandler(emitter);
    const result = await handler({
      command: 'pwd',
      cwd: '/tmp',
    });

    expect(result.stdout.trim()).toBe('/private/tmp'); // macOS /tmp -> /private/tmp
    expect(result.exitCode).toBe(0);
  });
});
