/**
 * Journal Component
 *
 * Real-time scrolling log of agent activity.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import type { JournalEntry, JournalEntryType } from '../../journal/manager.js';

export interface JournalProps {
  entries: JournalEntry[];
}

type FilterType = 'all' | JournalEntryType;

const ENTRY_TYPES: FilterType[] = [
  'all',
  'thought',
  'action',
  'observation',
  'reflection',
  'decision',
  'error',
  'milestone',
];

export function Journal({ entries }: JournalProps): React.ReactElement {
  const [filter, setFilter] = useState<FilterType>('all');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showFilter, setShowFilter] = useState(false);

  const filteredEntries = filter === 'all'
    ? entries
    : entries.filter((e) => e.entryType === filter);

  useInput((input, key) => {
    if (input === 'f') {
      setShowFilter(!showFilter);
    } else if (key.upArrow && !showFilter) {
      setSelectedIndex(Math.max(0, selectedIndex - 1));
    } else if (key.downArrow && !showFilter) {
      setSelectedIndex(Math.min(filteredEntries.length - 1, selectedIndex + 1));
    }
  });

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
      second: '2-digit',
      hour12: false,
    });
  };

  if (showFilter) {
    const items = ENTRY_TYPES.map((type) => ({
      label: type === 'all' ? 'All entries' : `${typeEmojis[type] ?? '•'} ${type}`,
      value: type,
    }));

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Filter by type:</Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              setFilter(item.value as FilterType);
              setShowFilter(false);
              setSelectedIndex(0);
            }}
          />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Header */}
      <Box marginBottom={1} justifyContent="space-between">
        <Text bold>Journal Entries</Text>
        <Box>
          <Text dimColor>Filter: </Text>
          <Text color="cyan">{filter}</Text>
          <Text dimColor> ({filteredEntries.length})</Text>
        </Box>
      </Box>

      {/* Entries list */}
      <Box flexDirection="column" flexGrow={1}>
        {filteredEntries.length === 0 ? (
          <Text dimColor>No entries matching filter</Text>
        ) : (
          filteredEntries.slice(0, 15).map((entry, i) => {
            const isSelected = i === selectedIndex;
            return (
              <Box
                key={entry.id}
                flexDirection="column"
                marginBottom={1}
                borderStyle={isSelected ? 'single' : undefined}
                borderColor={isSelected ? 'cyan' : undefined}
                paddingX={isSelected ? 1 : 0}
              >
                <Box>
                  <Text dimColor>[{formatTime(entry.createdAt)}] </Text>
                  <Text>{typeEmojis[entry.entryType] ?? '•'} </Text>
                  <Text color={typeColors[entry.entryType] ?? 'white'} bold>
                    {entry.entryType.toUpperCase()}
                  </Text>
                  {entry.tokensUsed && (
                    <Text dimColor> ({entry.tokensUsed} tokens)</Text>
                  )}
                </Box>
                <Box marginLeft={2}>
                  <Text wrap="wrap">
                    {isSelected
                      ? entry.content
                      : entry.content.slice(0, 80) + (entry.content.length > 80 ? '...' : '')}
                  </Text>
                </Box>
                {isSelected && entry.input && (
                  <Box marginLeft={2} marginTop={0}>
                    <Text dimColor>Input: {entry.input.slice(0, 50)}...</Text>
                  </Box>
                )}
                {isSelected && entry.output && (
                  <Box marginLeft={2}>
                    <Text dimColor>Output: {entry.output.slice(0, 50)}...</Text>
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
          <Text color="yellow">f</Text>-Filter{' '}
          <Text color="yellow">↑↓</Text>-Navigate{' '}
          <Text color="yellow">ESC</Text>-Back
        </Text>
      </Box>
    </Box>
  );
}
