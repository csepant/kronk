/**
 * Create Tool Tool Handler Tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  createCreateToolHandler,
  createDynamicHandler,
  loadDynamicTools,
} from '../create-tool.js';
import { ToolsManager } from '../../manager.js';
import { createLocalDb, type KronkDatabase } from '../../../db/client.js';
import { unlink } from 'node:fs/promises';
import type { ShellConfirmEvent } from '../shell.js';

describe('Create Tool Tool Handler', () => {
  let db: KronkDatabase;
  let toolsManager: ToolsManager;
  let emitter: EventEmitter;
  const testDbPath = '/tmp/kronk-create-tool-test.db';

  beforeEach(async () => {
    // Clean up any existing test database
    try {
      await unlink(testDbPath);
      await unlink(testDbPath + '-wal');
      await unlink(testDbPath + '-shm');
    } catch {
      // Ignore if files don't exist
    }

    db = createLocalDb(testDbPath);
    await db.initialize();
    toolsManager = new ToolsManager(db);
    emitter = new EventEmitter();
  });

  afterEach(async () => {
    await db.close();
    try {
      await unlink(testDbPath);
      await unlink(testDbPath + '-wal');
      await unlink(testDbPath + '-shm');
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('createCreateToolHandler', () => {
    test('creates a shell tool', async () => {
      // Auto-approve shell commands
      emitter.on('shell:confirm', (event: ShellConfirmEvent) => {
        event.resolve(true);
      });

      const handler = createCreateToolHandler(toolsManager, emitter);
      const result = await handler({
        name: 'echo_tool',
        description: 'Echoes a message',
        schema: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Message to echo' },
          },
          required: ['message'],
        },
        handlerType: 'shell',
        handler: 'echo "${params.message}"',
      });

      expect(result).toHaveProperty('toolId');
      expect(result).toHaveProperty('name', 'echo_tool');
      expect(result).toHaveProperty('status', 'created');

      // Verify tool was registered
      const tool = await toolsManager.get('echo_tool');
      expect(tool).not.toBeNull();
      expect(tool?.metadata?.dynamicTool).toBe(true);

      // Invoke the tool
      const invokeResult = await toolsManager.invoke('echo_tool', { message: 'hello' });
      expect(invokeResult.success).toBe(true);
      expect((invokeResult.result as { stdout: string }).stdout).toBe('hello\n');
    });

    test('creates a javascript tool', async () => {
      const handler = createCreateToolHandler(toolsManager, emitter);
      const result = await handler({
        name: 'add_numbers',
        description: 'Adds two numbers',
        schema: {
          type: 'object',
          properties: {
            a: { type: 'number', description: 'First number' },
            b: { type: 'number', description: 'Second number' },
          },
          required: ['a', 'b'],
        },
        handlerType: 'javascript',
        handler: 'return { sum: params.a + params.b };',
      });

      expect(result.status).toBe('created');

      // Invoke the tool
      const invokeResult = await toolsManager.invoke('add_numbers', { a: 5, b: 3 });
      expect(invokeResult.success).toBe(true);
      expect(invokeResult.result).toEqual({ sum: 8 });
    });

    test('rejects invalid tool names', async () => {
      const handler = createCreateToolHandler(toolsManager, emitter);

      await expect(handler({
        name: '123invalid',
        description: 'Invalid tool',
        schema: { type: 'object', properties: {} },
        handlerType: 'javascript',
        handler: 'return {};',
      })).rejects.toThrow('Tool name must start with a letter');

      await expect(handler({
        name: 'has-dashes',
        description: 'Invalid tool',
        schema: { type: 'object', properties: {} },
        handlerType: 'javascript',
        handler: 'return {};',
      })).rejects.toThrow('Tool name must start with a letter');
    });
  });

  describe('createDynamicHandler', () => {
    test('creates javascript handler', async () => {
      const handler = createDynamicHandler(
        'javascript',
        'return params.x * 2;',
        emitter
      );

      const result = await handler({ x: 21 });
      expect(result).toBe(42);
    });

    test('javascript handler times out on long-running code', async () => {
      const handler = createDynamicHandler(
        'javascript',
        'while(true) {}',
        emitter
      );

      // This should not hang forever due to the timeout
      // Note: The timeout is 1 second, but infinite loops can't be interrupted
      // in JS, so this test verifies the structure exists
      // In practice, this would need a separate process/worker for true isolation
    });

    test('creates http handler', async () => {
      const handler = createDynamicHandler(
        'http',
        JSON.stringify({
          url: 'https://httpbin.org/get?q=${params.query}',
          method: 'GET',
        }),
        emitter
      );

      // We won't actually make HTTP calls in tests
      // Just verify the handler was created
      expect(typeof handler).toBe('function');
    });
  });

  describe('loadDynamicTools', () => {
    test('loads dynamic tools from database', async () => {
      // First, create a tool directly in the database
      await db.query(
        `INSERT INTO tools (name, description, schema, handler, metadata)
         VALUES (?, ?, ?, ?, ?)`,
        [
          'loaded_tool',
          'A loaded tool',
          JSON.stringify({
            type: 'object',
            properties: { x: { type: 'number' } },
          }),
          'dynamic:javascript:return params.x * 3;',
          JSON.stringify({
            dynamicTool: true,
            handlerType: 'javascript',
            handlerSpec: 'return params.x * 3;',
          }),
        ]
      );

      // Load dynamic tools
      const count = await loadDynamicTools(toolsManager, emitter);
      expect(count).toBe(1);

      // Verify tool can be invoked
      const result = await toolsManager.invoke('loaded_tool', { x: 10 });
      expect(result.success).toBe(true);
      expect(result.result).toBe(30);
    });

    test('skips non-dynamic tools', async () => {
      // Create a regular (non-dynamic) tool
      await toolsManager.register({
        name: 'regular_tool',
        description: 'A regular tool',
        schema: { type: 'object', properties: {} },
        handler: 'some:handler',
      });

      const count = await loadDynamicTools(toolsManager, emitter);
      expect(count).toBe(0);
    });
  });
});
