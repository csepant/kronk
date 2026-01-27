/**
 * Dashboard Component
 *
 * Main overview showing agent status, memory tiers, and recent activity.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { JournalEntry } from '../../journal/manager.js';

export interface MemoryStats {
  system2: { count: number; avgImportance: number; totalTokens: number };
  working: { count: number; avgImportance: number; totalTokens: number };
  system1: { count: number; avgImportance: number; totalTokens: number };
}

export interface QueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

export interface DashboardProps {
  state: string;
  uptime: number;
  memoryStats: MemoryStats | null;
  journalEntries: JournalEntry[];
  queueStats: QueueStats | null;
}

export function Dashboard({
  state,
  uptime,
  memoryStats,
  journalEntries,
  queueStats,
}: DashboardProps): React.ReactElement {
  return (
    <Box flexDirection="row" flexGrow={1}>
      {/* Left column: Status and Memory */}
      <Box flexDirection="column" width="50%" paddingRight={1}>
        <StatusPanel state={state} uptime={uptime} />
        <MemoryPanel stats={memoryStats} />
        {queueStats && <QueuePanel stats={queueStats} />}
      </Box>

      {/* Right column: Journal */}
      <Box flexDirection="column" width="50%" paddingLeft={1}>
        <JournalPanel entries={journalEntries} />
      </Box>
    </Box>
  );
}

interface StatusPanelProps {
  state: string;
  uptime: number;
}

function StatusPanel({ state, uptime }: StatusPanelProps): React.ReactElement {
  const formatUptime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };

  const stateColors: Record<string, string> = {
    idle: 'green',
    thinking: 'yellow',
    acting: 'cyan',
    observing: 'blue',
    reflecting: 'magenta',
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginBottom={1}
    >
      <Text bold>Status</Text>
      <Box marginTop={1}>
        <Text>State: </Text>
        <Text color={stateColors[state] ?? 'white'}>{state}</Text>
      </Box>
      <Box>
        <Text>Uptime: </Text>
        <Text>{formatUptime(uptime)}</Text>
      </Box>
    </Box>
  );
}

interface MemoryPanelProps {
  stats: MemoryStats | null;
}

function MemoryPanel({ stats }: MemoryPanelProps): React.ReactElement {
  if (!stats) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
        <Text bold>Memory</Text>
        <Text dimColor> Loading...</Text>
      </Box>
    );
  }

  const maxTokens = {
    system2: 4000,
    working: 8000,
    system1: 4000,
  };

  const renderBar = (used: number, max: number, color: string): React.ReactElement => {
    const percentage = Math.min(100, (used / max) * 100);
    const barWidth = 20;
    const filled = Math.round((percentage / 100) * barWidth);
    const empty = barWidth - filled;

    return (
      <Text>
        <Text color={color}>{'█'.repeat(filled)}</Text>
        <Text dimColor>{'░'.repeat(empty)}</Text>
        <Text dimColor> {used}/{max}</Text>
      </Text>
    );
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginBottom={1}
    >
      <Text bold>Memory</Text>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text>System2: </Text>
          <Text dimColor>({stats.system2.count}) </Text>
          {renderBar(stats.system2.totalTokens, maxTokens.system2, 'blue')}
        </Box>
        <Box>
          <Text>Working: </Text>
          <Text dimColor>({stats.working.count}) </Text>
          {renderBar(stats.working.totalTokens, maxTokens.working, 'cyan')}
        </Box>
        <Box>
          <Text>System1: </Text>
          <Text dimColor>({stats.system1.count}) </Text>
          {renderBar(stats.system1.totalTokens, maxTokens.system1, 'green')}
        </Box>
      </Box>
    </Box>
  );
}

interface QueuePanelProps {
  stats: QueueStats;
}

function QueuePanel({ stats }: QueuePanelProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginBottom={1}
    >
      <Text bold>Task Queue</Text>
      <Box marginTop={1}>
        <Text color="yellow">{stats.pending}</Text>
        <Text dimColor> pending | </Text>
        <Text color="cyan">{stats.running}</Text>
        <Text dimColor> running | </Text>
        <Text color="green">{stats.completed}</Text>
        <Text dimColor> done | </Text>
        <Text color="red">{stats.failed}</Text>
        <Text dimColor> failed</Text>
      </Box>
    </Box>
  );
}

interface JournalPanelProps {
  entries: JournalEntry[];
}

function JournalPanel({ entries }: JournalPanelProps): React.ReactElement {
  const typeEmojis: Record<string, string> = {
    thought: '💭',
    action: '⚡',
    observation: '👁',
    reflection: '🪞',
    decision: '⚖',
    error: '❌',
    milestone: '🎯',
  };

  const typeColors: Record<string, string> = {
    thought: 'yellow',
    action: 'cyan',
    observation: 'blue',
    reflection: 'magenta',
    decision: 'green',
    error: 'red',
    milestone: 'green',
  };

  const formatTime = (date: Date): string => {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      flexGrow={1}
    >
      <Text bold>Recent Journal</Text>

      <Box marginTop={1} flexDirection="column" flexGrow={1}>
        {entries.length === 0 ? (
          <Text dimColor>No entries yet</Text>
        ) : (
          entries.slice(0, 10).map((entry) => (
            <Box key={entry.id} marginBottom={0}>
              <Text dimColor>[{formatTime(entry.createdAt)}] </Text>
              <Text>{typeEmojis[entry.entryType] ?? '•'} </Text>
              <Text color={typeColors[entry.entryType] ?? 'white'}>
                {entry.content.slice(0, 50)}{entry.content.length > 50 ? '...' : ''}
              </Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
