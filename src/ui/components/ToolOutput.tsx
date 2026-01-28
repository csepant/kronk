/**
 * ToolOutput Component
 *
 * Displays tool call outputs as expandable/collapsible elements in the chat UI.
 * Press Ctrl+E to expand/collapse when focused.
 */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

export interface ToolCall {
  id: string;
  name: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  status: 'running' | 'complete' | 'error';
  timestamp: Date;
}

export interface ToolOutputProps {
  toolCall: ToolCall;
  isExpanded: boolean;
  isSelected: boolean;
}

/** Truncate text to a max length with ellipsis */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/** Format a value for display */
function formatValue(value: unknown, maxLength = 100): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return truncate(value, maxLength);
  try {
    const str = JSON.stringify(value, null, 2);
    return str;
  } catch {
    return String(value);
  }
}

/** Format params as a brief summary */
function formatParamsSummary(params: Record<string, unknown>): string {
  const keys = Object.keys(params);
  if (keys.length === 0) return '';
  if (keys.length === 1) {
    const val = params[keys[0]];
    if (typeof val === 'string') return truncate(val, 40);
    return truncate(JSON.stringify(val), 40);
  }
  return `${keys.length} params`;
}

/** Get icon/symbol for tool status */
function getStatusIndicator(status: ToolCall['status']): React.ReactElement {
  switch (status) {
    case 'running':
      return <Spinner type="dots" />;
    case 'complete':
      return <Text color="green">✓</Text>;
    case 'error':
      return <Text color="red">✗</Text>;
  }
}

/** Get color for tool status */
function getStatusColor(status: ToolCall['status']): string {
  switch (status) {
    case 'running':
      return 'yellow';
    case 'complete':
      return 'green';
    case 'error':
      return 'red';
  }
}

export function ToolOutput({ toolCall, isExpanded, isSelected }: ToolOutputProps): React.ReactElement {
  const paramsSummary = formatParamsSummary(toolCall.params);

  return (
    <Box
      flexDirection="column"
      borderStyle={isSelected ? 'single' : undefined}
      borderColor={isSelected ? 'cyan' : undefined}
      paddingX={isSelected ? 1 : 0}
      marginY={0}
    >
      {/* Collapsed header - always visible */}
      <Box>
        <Text dimColor>[</Text>
        {getStatusIndicator(toolCall.status)}
        <Text dimColor>] </Text>
        <Text color={getStatusColor(toolCall.status)} bold>
          {toolCall.name}
        </Text>
        {paramsSummary && (
          <>
            <Text dimColor> · </Text>
            <Text dimColor>{paramsSummary}</Text>
          </>
        )}
        {!isExpanded && toolCall.status === 'complete' && (
          <>
            <Text dimColor> → </Text>
            <Text dimColor>
              {truncate(formatValue(toolCall.result, 60), 60)}
            </Text>
          </>
        )}
        {isSelected && (
          <Text dimColor italic> (Ctrl+E to {isExpanded ? 'collapse' : 'expand'})</Text>
        )}
      </Box>

      {/* Expanded content */}
      {isExpanded && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          {/* Parameters */}
          {Object.keys(toolCall.params).length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text color="blue" bold>Parameters:</Text>
              <Box marginLeft={2} flexDirection="column">
                {Object.entries(toolCall.params).map(([key, value]) => (
                  <Box key={key}>
                    <Text color="cyan">{key}: </Text>
                    <Text wrap="wrap">{formatValue(value, 500)}</Text>
                  </Box>
                ))}
              </Box>
            </Box>
          )}

          {/* Result or Error */}
          {toolCall.status === 'complete' && toolCall.result !== undefined && (
            <Box flexDirection="column">
              <Text color="green" bold>Result:</Text>
              <Box marginLeft={2}>
                <Text wrap="wrap">{formatValue(toolCall.result, 2000)}</Text>
              </Box>
            </Box>
          )}

          {toolCall.status === 'error' && toolCall.error && (
            <Box flexDirection="column">
              <Text color="red" bold>Error:</Text>
              <Box marginLeft={2}>
                <Text color="red" wrap="wrap">{toolCall.error}</Text>
              </Box>
            </Box>
          )}

          {toolCall.status === 'running' && (
            <Box>
              <Text dimColor italic>Executing...</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

/**
 * ToolOutputList Component
 *
 * Displays a list of tool calls with selection and expansion support.
 */
export interface ToolOutputListProps {
  toolCalls: ToolCall[];
  selectedIndex: number;
  expandedIds: Set<string>;
}

export function ToolOutputList({ toolCalls, selectedIndex, expandedIds }: ToolOutputListProps): React.ReactElement {
  if (toolCalls.length === 0) {
    return <></>;
  }

  return (
    <Box flexDirection="column" marginLeft={2}>
      {toolCalls.map((toolCall, index) => (
        <ToolOutput
          key={toolCall.id}
          toolCall={toolCall}
          isSelected={index === selectedIndex}
          isExpanded={expandedIds.has(toolCall.id)}
        />
      ))}
    </Box>
  );
}
