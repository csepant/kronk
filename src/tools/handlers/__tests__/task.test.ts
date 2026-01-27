/**
 * Create Task Tool Handler Tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTaskHandler } from '../task.js';
import { createLocalDb, type KronkDatabase } from '../../../db/client.js';
import { unlink } from 'node:fs/promises';

describe('Create Task Tool Handler', () => {
  let db: KronkDatabase;
  const testDbPath = '/tmp/kronk-task-test.db';

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

  test('creates task with minimal parameters', async () => {
    const handler = createTaskHandler(db);
    const result = await handler({ type: 'test_task' });

    expect(result).toHaveProperty('taskId');
    expect(result).toHaveProperty('status', 'pending');
    expect(typeof result.taskId).toBe('string');

    // Verify task exists in database
    const dbResult = await db.query(
      'SELECT * FROM task_queue WHERE id = ?',
      [result.taskId]
    );
    expect(dbResult.rows.length).toBe(1);
    expect(dbResult.rows[0].type).toBe('test_task');
    expect(dbResult.rows[0].status).toBe('pending');
  });

  test('creates task with all parameters', async () => {
    const handler = createTaskHandler(db);
    const payload = { key: 'value', count: 42 };
    const result = await handler({
      type: 'full_task',
      payload,
      priority: 10,
      maxRetries: 5,
    });

    expect(result.taskId).toBeDefined();
    expect(result.status).toBe('pending');

    // Verify task in database
    const dbResult = await db.query(
      'SELECT * FROM task_queue WHERE id = ?',
      [result.taskId]
    );
    const task = dbResult.rows[0];
    expect(task.type).toBe('full_task');
    expect(JSON.parse(task.payload as string)).toEqual(payload);
    expect(task.priority).toBe(10);
    expect(task.max_retries).toBe(5);
  });

  test('creates multiple tasks independently', async () => {
    const handler = createTaskHandler(db);

    const result1 = await handler({ type: 'task_a' });
    const result2 = await handler({ type: 'task_b' });
    const result3 = await handler({ type: 'task_c', priority: 100 });

    expect(result1.taskId).not.toBe(result2.taskId);
    expect(result2.taskId).not.toBe(result3.taskId);

    // Verify all tasks exist
    const dbResult = await db.query(
      'SELECT COUNT(*) as count FROM task_queue WHERE status = ?',
      ['pending']
    );
    expect(dbResult.rows[0].count).toBe(3);
  });

  test('uses default values for optional parameters', async () => {
    const handler = createTaskHandler(db);
    const result = await handler({ type: 'default_task' });

    const dbResult = await db.query(
      'SELECT * FROM task_queue WHERE id = ?',
      [result.taskId]
    );
    const task = dbResult.rows[0];
    expect(task.priority).toBe(0);
    expect(task.max_retries).toBe(3);
    expect(task.payload).toBeNull();
  });
});
