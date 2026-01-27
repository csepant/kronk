/**
 * Chat Component
 *
 * Interactive chat interface for communicating with the agent.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { Agent } from '../../core/agent.js';

export interface ChatProps {
  agent: Agent;
  onMessage: (message: string) => Promise<void>;
  isRunning: boolean;
  isThinking: boolean;
  currentThought: string;
  lastResponse: string | null;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

export function Chat({
  agent,
  onMessage,
  isRunning,
  isThinking,
  currentThought,
  lastResponse,
}: ChatProps): React.ReactElement {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  useEffect(() => {
    if (lastResponse) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: lastResponse, timestamp: new Date() },
      ]);
    }
  }, [lastResponse]);

  useInput((inputChar, key) => {
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
          messages.slice(-10).map((msg, i) => (
            <Box key={i} marginBottom={1} flexDirection="column">
              <Box>
                <Text dimColor>[{formatTime(msg.timestamp)}] </Text>
                <Text color={msg.role === 'user' ? 'cyan' : 'green'} bold>
                  {msg.role === 'user' ? 'You' : 'Agent'}:
                </Text>
              </Box>
              <Box marginLeft={2}>
                <Text wrap="wrap">{msg.content}</Text>
              </Box>
            </Box>
          ))
        )}

        {isRunning && (
          <Box marginTop={1} flexDirection="column">
            <Box>
              <Spinner type="dots" />
              <Text color="yellow"> {isThinking ? 'Thinking...' : 'Processing...'}</Text>
            </Box>
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
        <Text dimColor>Enter to send | Up/Down for history | ESC to go back</Text>
      </Box>
    </Box>
  );
}
