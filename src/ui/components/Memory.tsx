/**
 * Memory Component
 *
 * Memory tier visualization with statistics.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { MemoryStats } from './Dashboard.js';

export interface MemoryProps {
  stats: MemoryStats | null;
}

type MemoryTier = 'system2' | 'working' | 'system1';

const TIER_INFO: Record<MemoryTier, { name: string; description: string; color: string; maxTokens: number }> = {
  system2: {
    name: 'System 2 / Long Horizon',
    description: 'Strategic memory: goals, principles, learned patterns',
    color: 'blue',
    maxTokens: 4000,
  },
  working: {
    name: 'Working Memory',
    description: 'Active context: current tasks, recent decisions',
    color: 'cyan',
    maxTokens: 8000,
  },
  system1: {
    name: 'System 1 / Short Term',
    description: 'Reactive memory: recent interactions, immediate context',
    color: 'green',
    maxTokens: 4000,
  },
};

export function Memory({ stats }: MemoryProps): React.ReactElement {
  const [selectedTier, setSelectedTier] = useState<MemoryTier>('system2');

  useInput((input, key) => {
    if (key.upArrow || input === 'k') {
      const tiers: MemoryTier[] = ['system2', 'working', 'system1'];
      const currentIndex = tiers.indexOf(selectedTier);
      if (currentIndex > 0) {
        setSelectedTier(tiers[currentIndex - 1]);
      }
    } else if (key.downArrow || input === 'j') {
      const tiers: MemoryTier[] = ['system2', 'working', 'system1'];
      const currentIndex = tiers.indexOf(selectedTier);
      if (currentIndex < tiers.length - 1) {
        setSelectedTier(tiers[currentIndex + 1]);
      }
    }
  });

  if (!stats) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Loading memory statistics...</Text>
      </Box>
    );
  }

  const renderProgressBar = (used: number, max: number, color: string): React.ReactElement => {
    const percentage = Math.min(100, (used / max) * 100);
    const barWidth = 40;
    const filled = Math.round((percentage / 100) * barWidth);
    const empty = barWidth - filled;

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(empty)}</Text>
        </Box>
        <Box>
          <Text dimColor>{used.toLocaleString()} / {max.toLocaleString()} tokens ({percentage.toFixed(1)}%)</Text>
        </Box>
      </Box>
    );
  };

  const renderTierCard = (tier: MemoryTier): React.ReactElement => {
    const info = TIER_INFO[tier];
    const tierStats = stats[tier];
    const isSelected = selectedTier === tier;

    return (
      <Box
        key={tier}
        flexDirection="column"
        borderStyle={isSelected ? 'double' : 'single'}
        borderColor={isSelected ? info.color : 'gray'}
        paddingX={1}
        marginBottom={1}
      >
        <Box justifyContent="space-between">
          <Text color={info.color} bold>{info.name}</Text>
          <Text dimColor>{tierStats.count} memories</Text>
        </Box>

        <Box marginTop={1}>
          {renderProgressBar(tierStats.totalTokens, info.maxTokens, info.color)}
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{info.description}</Text>
          <Box marginTop={1}>
            <Text>Avg Importance: </Text>
            <Text color={getImportanceColor(tierStats.avgImportance)}>
              {tierStats.avgImportance.toFixed(3)}
            </Text>
          </Box>
        </Box>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold>Memory Tiers</Text>
      </Box>

      {/* Summary */}
      <Box marginBottom={1} borderStyle="round" borderColor="gray" paddingX={1}>
        <Text>Total: </Text>
        <Text color="cyan">{stats.system2.count + stats.working.count + stats.system1.count}</Text>
        <Text> memories | </Text>
        <Text color="cyan">
          {(stats.system2.totalTokens + stats.working.totalTokens + stats.system1.totalTokens).toLocaleString()}
        </Text>
        <Text> tokens</Text>
      </Box>

      {/* Tier cards */}
      <Box flexDirection="column" flexGrow={1}>
        {renderTierCard('system2')}
        {renderTierCard('working')}
        {renderTierCard('system1')}
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          <Text color="yellow">↑↓</Text>-Select tier{' '}
          <Text color="yellow">ESC</Text>-Back
        </Text>
      </Box>
    </Box>
  );
}

function getImportanceColor(importance: number): string {
  if (importance >= 0.7) return 'green';
  if (importance >= 0.4) return 'yellow';
  return 'red';
}
