/**
 * TaskQueue Component
 *
 * Display and manage background tasks.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { QueueManager, QueueTask, TaskStatus } from '../../queue/manager.js';
import type { QueueStats } from './Dashboard.js';

export interface TaskQueueProps {
  queue: QueueManager;
  stats: QueueStats | null;
}

export function TaskQueue({ queue, stats }: TaskQueueProps): React.ReactElement {
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadTasks = async () => {
      setLoading(true);
      try {
        const taskList = await queue.list({
          status: filter === 'all' ? undefined : filter,
          limit: 50,
        });
        setTasks(taskList);
      } catch (error) {
        // Handle error silently
      }
      setLoading(false);
    };

    loadTasks();

    // Set up event listeners for real-time updates
    const handleTaskAdded = (task: QueueTask) => {
      setTasks((prev) => [task, ...prev]);
    };

    const handleTaskCompleted = (task: QueueTask) => {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
    };

    const handleTaskFailed = (task: QueueTask) => {
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
    };

    queue.on('task:added', handleTaskAdded);
    queue.on('task:completed', handleTaskCompleted);
    queue.on('task:failed', handleTaskFailed);

    return () => {
      queue.removeListener('task:added', handleTaskAdded);
      queue.removeListener('task:completed', handleTaskCompleted);
      queue.removeListener('task:failed', handleTaskFailed);
    };
  }, [queue, filter]);

  useInput(async (input, key) => {
    if (key.upArrow || input === 'k') {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    } else if (key.downArrow || input === 'j') {
      setSelectedIndex(Math.min(tasks.length - 1, selectedIndex + 1));
    } else if (input === 'c' && tasks[selectedIndex]?.status === 'pending') {
      // Cancel selected task
      const task = tasks[selectedIndex];
      if (task) {
        await queue.cancel(task.id);
        setTasks((prev) => prev.map((t) =>
          t.id === task.id ? { ...t, status: 'cancelled' } : t
        ));
      }
    } else if (input === 'f') {
      // Cycle through filters
      const filters: Array<TaskStatus | 'all'> = ['all', 'pending', 'running', 'completed', 'failed'];
      const currentIndex = filters.indexOf(filter);
      setFilter(filters[(currentIndex + 1) % filters.length]);
      setSelectedIndex(0);
    }
  });

  const statusColors: Record<TaskStatus, string> = {
    pending: 'yellow',
    running: 'cyan',
    completed: 'green',
    failed: 'red',
    cancelled: 'gray',
  };

  const statusIcons: Record<TaskStatus, string> = {
    pending: '○',
    running: '◉',
    completed: '✓',
    failed: '✗',
    cancelled: '⊘',
  };

  const formatTime = (date: Date | null): string => {
    if (!date) return '-';
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  };

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Header with stats */}
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold>Task Queue</Text>
        {stats && (
          <Box>
            <Text color="yellow">{stats.pending}</Text>
            <Text dimColor> pending | </Text>
            <Text color="cyan">{stats.running}</Text>
            <Text dimColor> running | </Text>
            <Text color="green">{stats.completed}</Text>
            <Text dimColor> done | </Text>
            <Text color="red">{stats.failed}</Text>
            <Text dimColor> failed</Text>
          </Box>
        )}
      </Box>

      {/* Filter indicator */}
      <Box marginBottom={1}>
        <Text dimColor>Filter: </Text>
        <Text color="cyan">{filter}</Text>
        <Text dimColor> (press f to change)</Text>
      </Box>

      {/* Tasks list */}
      <Box flexDirection="column" flexGrow={1}>
        {loading ? (
          <Box>
            <Spinner type="dots" />
            <Text> Loading tasks...</Text>
          </Box>
        ) : tasks.length === 0 ? (
          <Text dimColor>No tasks {filter !== 'all' ? `with status '${filter}'` : ''}</Text>
        ) : (
          tasks.slice(0, 12).map((task, i) => {
            const isSelected = i === selectedIndex;
            return (
              <Box
                key={task.id}
                flexDirection="column"
                borderStyle={isSelected ? 'single' : undefined}
                borderColor={isSelected ? 'cyan' : undefined}
                paddingX={isSelected ? 1 : 0}
                marginBottom={isSelected ? 1 : 0}
              >
                <Box>
                  {task.status === 'running' ? (
                    <Box marginRight={1}>
                      <Spinner type="dots" />
                    </Box>
                  ) : (
                    <Text color={statusColors[task.status]}>
                      {statusIcons[task.status]}{' '}
                    </Text>
                  )}
                  <Text bold>{task.type}</Text>
                  <Text dimColor> (priority: {task.priority})</Text>
                  {task.retryCount > 0 && (
                    <Text color="yellow"> [retry {task.retryCount}/{task.maxRetries}]</Text>
                  )}
                </Box>

                {isSelected && (
                  <Box flexDirection="column" marginLeft={2} marginTop={1}>
                    <Box>
                      <Text dimColor>ID: </Text>
                      <Text>{task.id}</Text>
                    </Box>
                    <Box>
                      <Text dimColor>Status: </Text>
                      <Text color={statusColors[task.status]}>{task.status}</Text>
                    </Box>
                    <Box>
                      <Text dimColor>Created: </Text>
                      <Text>{formatTime(task.createdAt)}</Text>
                    </Box>
                    {task.startedAt && (
                      <Box>
                        <Text dimColor>Started: </Text>
                        <Text>{formatTime(task.startedAt)}</Text>
                      </Box>
                    )}
                    {task.completedAt && (
                      <Box>
                        <Text dimColor>Completed: </Text>
                        <Text>{formatTime(task.completedAt)}</Text>
                      </Box>
                    )}
                    {task.error && (
                      <Box>
                        <Text dimColor>Error: </Text>
                        <Text color="red">{task.error}</Text>
                      </Box>
                    )}
                    {task.payload && (
                      <Box>
                        <Text dimColor>Payload: </Text>
                        <Text>{JSON.stringify(task.payload).slice(0, 50)}...</Text>
                      </Box>
                    )}
                  </Box>
                )}
              </Box>
            );
          })
        )}
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          <Text color="yellow">↑↓</Text>-Navigate{' '}
          <Text color="yellow">f</Text>-Filter{' '}
          <Text color="yellow">c</Text>-Cancel{' '}
          <Text color="yellow">ESC</Text>-Back
        </Text>
      </Box>
    </Box>
  );
}
