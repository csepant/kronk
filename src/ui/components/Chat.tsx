/**
 * Chat Component
 *
 * Interactive chat interface for communicating with the agent.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { Agent, RunResult } from '../../core/agent.js';
import { ToolOutput, type ToolCall } from './ToolOutput.js';
import { Markdown } from './Markdown.js';

export interface ChatProps {
  agent: Agent;
  onMessage: (message: string) => Promise<void>;
  isRunning: boolean;
  isThinking: boolean;
  currentThought: string;
  lastResponse: string | null;
  toolCalls?: ToolCall[];
  debugMode?: boolean;
  lastResult?: RunResult | null;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  /** Tool calls associated with this message (for assistant messages) */
  toolCalls?: ToolCall[];
}

export function Chat({
  agent,
  onMessage,
  isRunning,
  isThinking,
  currentThought,
  lastResponse,
  toolCalls = [],
  debugMode = false,
  lastResult,
}: ChatProps): React.ReactElement {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Tool output expansion state
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(new Set());
  const [selectedToolIndex, setSelectedToolIndex] = useState(-1);
  const [isToolFocusMode, setIsToolFocusMode] = useState(false);

  // Store previous toolCalls ref to detect new completions
  const prevToolCallsRef = React.useRef<ToolCall[]>([]);

  useEffect(() => {
    if (lastResponse) {
      // Capture tool calls from this response
      const responseToolCalls = [...prevToolCallsRef.current];
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: lastResponse,
          timestamp: new Date(),
          toolCalls: responseToolCalls.length > 0 ? responseToolCalls : undefined,
        },
      ]);
      prevToolCallsRef.current = [];
    }
  }, [lastResponse]);

  // Track tool calls as they come in (before response completes)
  useEffect(() => {
    if (isRunning && toolCalls.length > 0) {
      prevToolCallsRef.current = [...toolCalls];
    }
  }, [toolCalls, isRunning]);

  // Get all displayable tool calls: current running + from messages
  const allDisplayableToolCalls = React.useMemo(() => {
    // Get recent messages' tool calls for selection
    const recentMessages = messages.slice(-10);
    const historicalToolCalls: ToolCall[] = [];
    for (const msg of recentMessages) {
      if (msg.toolCalls) {
        historicalToolCalls.push(...msg.toolCalls);
      }
    }
    // Add currently running tool calls
    return [...historicalToolCalls, ...toolCalls];
  }, [messages, toolCalls]);

  useInput((inputChar, key) => {
    // Ctrl+E to toggle expansion of selected tool
    if (key.ctrl && inputChar === 'e') {
      if (allDisplayableToolCalls.length > 0) {
        if (!isToolFocusMode) {
          // Enter tool focus mode
          setIsToolFocusMode(true);
          setSelectedToolIndex(allDisplayableToolCalls.length - 1); // Select most recent
        } else if (selectedToolIndex >= 0 && selectedToolIndex < allDisplayableToolCalls.length) {
          // Toggle expansion of selected tool
          const toolId = allDisplayableToolCalls[selectedToolIndex].id;
          setExpandedToolIds((prev) => {
            const next = new Set(prev);
            if (next.has(toolId)) {
              next.delete(toolId);
            } else {
              next.add(toolId);
            }
            return next;
          });
        }
      }
      return;
    }

    // Escape to exit tool focus mode
    if (key.escape && isToolFocusMode) {
      setIsToolFocusMode(false);
      setSelectedToolIndex(-1);
      return;
    }

    // Navigate tool selection in focus mode
    if (isToolFocusMode) {
      if (key.upArrow && selectedToolIndex > 0) {
        setSelectedToolIndex(selectedToolIndex - 1);
        return;
      }
      if (key.downArrow && selectedToolIndex < allDisplayableToolCalls.length - 1) {
        setSelectedToolIndex(selectedToolIndex + 1);
        return;
      }
      // Any other key exits focus mode (except arrow keys when at bounds)
      if (!key.upArrow && !key.downArrow) {
        setIsToolFocusMode(false);
        setSelectedToolIndex(-1);
      }
    }

    // Standard history navigation (when not in tool focus mode)
    if (!isToolFocusMode) {
      if (key.upArrow && history.length > 0) {
        const newIndex = Math.min(historyIndex + 1, history.length - 1);
        setHistoryIndex(newIndex);
        setInput(history[history.length - 1 - newIndex] ?? '');
      } else if (key.downArrow && historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setInput(history[history.length - 1 - newIndex] ?? '');
      } else if (key.downArrow && historyIndex === 0) {
        setHistoryIndex(-1);
        setInput('');
      }
    }
  });

  const handleSubmit = async (value: string) => {
    if (!value.trim() || isRunning) {
      return;
    }

    const userMessage = value.trim();
    setInput('');
    setHistory((prev) => [...prev, userMessage]);
    setHistoryIndex(-1);

    setMessages((prev) => [
      ...prev,
      { role: 'user', content: userMessage, timestamp: new Date() },
    ]);

    await onMessage(userMessage);
  };

  const formatTime = (date: Date): string => {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  };

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {/* Messages area */}
      <Box flexDirection="column" flexGrow={1} marginBottom={1}>
        {messages.length === 0 ? (
          <Box flexDirection="column" justifyContent="center" alignItems="center" flexGrow={1}>
            <Text dimColor>Start a conversation with the agent</Text>
            <Text dimColor>Type your message below and press Enter</Text>
          </Box>
        ) : (
          messages.slice(-10).map((msg, i) => {
            // Calculate tool index offset for this message
            const msgToolCalls = msg.toolCalls ?? [];

            return (
              <Box key={i} marginBottom={1} flexDirection="column">
                <Box>
                  <Text dimColor>[{formatTime(msg.timestamp)}] </Text>
                  <Text color={msg.role === 'user' ? 'cyan' : 'green'} bold>
                    {msg.role === 'user' ? 'You' : 'Agent'}:
                  </Text>
                </Box>

                {/* Show tool calls for assistant messages */}
                {msg.role === 'assistant' && msgToolCalls.length > 0 && (
                  <Box flexDirection="column" marginLeft={2} marginBottom={1}>
                    {msgToolCalls.map((tc) => {
                      const globalIndex = allDisplayableToolCalls.findIndex(
                        (t) => t.id === tc.id
                      );
                      return (
                        <ToolOutput
                          key={tc.id}
                          toolCall={tc}
                          isSelected={isToolFocusMode && globalIndex === selectedToolIndex}
                          isExpanded={expandedToolIds.has(tc.id)}
                        />
                      );
                    })}
                  </Box>
                )}

                <Box marginLeft={2}>
                  {msg.role === 'assistant' ? (
                    <Markdown>{msg.content}</Markdown>
                  ) : (
                    <Text wrap="wrap">{msg.content}</Text>
                  )}
                </Box>
              </Box>
            );
          })
        )}

        {isRunning && (
          <Box marginTop={1} flexDirection="column">
            <Box>
              <Spinner type="dots" />
              <Text color="yellow"> {isThinking ? 'Thinking...' : 'Processing...'}</Text>
            </Box>

            {/* Show currently running tool calls */}
            {toolCalls.length > 0 && (
              <Box flexDirection="column" marginLeft={2} marginTop={1}>
                {toolCalls.map((tc) => {
                  const globalIndex = allDisplayableToolCalls.findIndex(
                    (t) => t.id === tc.id
                  );
                  return (
                    <ToolOutput
                      key={tc.id}
                      toolCall={tc}
                      isSelected={isToolFocusMode && globalIndex === selectedToolIndex}
                      isExpanded={expandedToolIds.has(tc.id)}
                    />
                  );
                })}
              </Box>
            )}

            {isThinking && currentThought && (
              <Box marginTop={1} marginLeft={2} flexDirection="column">
                <Text dimColor wrap="wrap">
                  {currentThought.length > 500
                    ? currentThought.slice(-500) + '...'
                    : currentThought}
                </Text>
              </Box>
            )}
          </Box>
        )}
      </Box>

      {/* Debug Panel */}
      {debugMode && lastResult && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="magenta"
          paddingX={1}
          marginBottom={1}
        >
          <Text bold color="magenta">Debug Info - Raw LLM Response</Text>
          <Box flexDirection="column" marginTop={1}>
            <Box>
              <Text dimColor>Status: </Text>
              <Text color={lastResult.success ? 'green' : 'red'}>
                {lastResult.success ? 'Success' : 'Error'}
              </Text>
              {lastResult.error && <Text color="red"> - {lastResult.error}</Text>}
            </Box>
            <Box>
              <Text dimColor>Iterations: </Text>
              <Text>{lastResult.iterations}</Text>
              <Text dimColor> | Tokens: </Text>
              <Text>{lastResult.tokensUsed.toLocaleString()}</Text>
            </Box>

            {/* Raw LLM Responses */}
            {lastResult.rawLlmResponses && lastResult.rawLlmResponses.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor bold>Raw LLM Responses ({lastResult.rawLlmResponses.length} iteration{lastResult.rawLlmResponses.length > 1 ? 's' : ''}):</Text>
                {lastResult.rawLlmResponses.map((raw, i) => {
                  const rawJson = JSON.stringify({
                    iteration: i + 1,
                    tokensUsed: raw.tokensUsed,
                    duration: `${raw.completedAt.getTime() - raw.startedAt.getTime()}ms`,
                    chunksCount: raw.chunks.length,
                    content: raw.chunks.join(''),
                    toolCalls: raw.toolCalls.length > 0 ? raw.toolCalls : undefined,
                  }, null, 2);
                  const displayJson = rawJson.length > 1000 ? rawJson.slice(0, 1000) + '\n  ... (truncated)' : rawJson;
                  return (
                    <Box key={i} flexDirection="column" marginTop={1} marginLeft={1}>
                      <Text color="yellow">--- Iteration {i + 1} ---</Text>
                      <Box marginLeft={1}>
                        <Text wrap="wrap" color="gray">{displayJson}</Text>
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            )}

            {/* Summary stats */}
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>Journal: {lastResult.journalEntries.length} entries | Memories: {lastResult.memoriesCreated.length} created</Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* Input area */}
      <Box
        borderStyle="round"
        borderColor={isRunning ? 'gray' : 'cyan'}
        paddingX={1}
      >
        <Text color="cyan">&gt; </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          placeholder={isRunning ? 'Waiting for response...' : 'Type your message...'}
        />
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          {isToolFocusMode
            ? 'Ctrl+E expand/collapse | Up/Down navigate tools | ESC exit tool mode'
            : `Enter to send | Up/Down history | Ctrl+E expand tools${debugMode ? ' | d toggle debug' : ''} | ESC back`}
        </Text>
      </Box>
    </Box>
  );
}
