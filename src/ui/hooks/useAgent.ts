/**
 * useAgent Hook
 *
 * React hook for managing agent state in the TUI.
 */

import { useState, useEffect, useCallback } from 'react';
import type { Agent, AgentState, RunResult } from '../../core/agent.js';
import type { JournalEntry } from '../../journal/manager.js';
import type { QueueManager } from '../../queue/manager.js';
import type { MemoryStats, QueueStats } from '../components/Dashboard.js';
import type { ToolCall } from '../components/ToolOutput.js';

export interface UseAgentState {
  state: AgentState;
  uptime: number;
  isRunning: boolean;
  isThinking: boolean;
  currentThought: string;
  memoryStats: MemoryStats | null;
  queueStats: QueueStats | null;
  recentJournal: JournalEntry[];
  lastResponse: string | null;
  lastResult: RunResult | null;
  toolCalls: ToolCall[];
  runMessage: (message: string) => Promise<void>;
  refresh: () => Promise<void>;
  clearToolCalls: () => void;
}

export function useAgent(agent: Agent, queue?: QueueManager): UseAgentState {
  const [state, setState] = useState<AgentState>(agent.getState());
  const [uptime, setUptime] = useState<number>(agent.getUptime());
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [isThinking, setIsThinking] = useState<boolean>(false);
  const [currentThought, setCurrentThought] = useState<string>('');
  const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null);
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null);
  const [recentJournal, setRecentJournal] = useState<JournalEntry[]>([]);
  const [lastResponse, setLastResponse] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<RunResult | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);

  // Generate unique ID for tool calls
  const generateToolId = useCallback(() => {
    return `tool-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }, []);

  // Clear tool calls (typically when starting a new message)
  const clearToolCalls = useCallback(() => {
    setToolCalls([]);
  }, []);

  // Load initial data
  const loadData = useCallback(async () => {
    try {
      const instance = agent.getInstance();

      // Load memory stats
      const stats = await instance.memory.getStats();
      setMemoryStats(stats);

      // Load recent journal entries
      const entries = await instance.journal.getRecent(20);
      setRecentJournal(entries);

      // Load queue stats if available
      if (queue) {
        const qStats = await queue.getStats();
        setQueueStats(qStats);
      }
    } catch (error) {
      // Silently handle errors during refresh
    }
  }, [agent, queue]);

  // Set up event listeners
  useEffect(() => {
    // State changes
    const handleStateChange = (newState: AgentState) => {
      setState(newState);
    };

    // Journal entries
    const handleJournalEntry = (entry: JournalEntry) => {
      setRecentJournal((prev) => [entry, ...prev].slice(0, 20));
    };

    // Run completion
    const handleRunComplete = (result: RunResult) => {
      setLastResult(result);
      // Show response or error message
      if (result.success && result.response) {
        setLastResponse(result.response);
      } else if (result.error) {
        setLastResponse(`Error: ${result.error}`);
      }
      setIsRunning(false);
    };

    // Run start
    const handleRunStart = () => {
      setIsRunning(true);
    };

    // Thinking events
    const handleThinkingStart = () => {
      setIsThinking(true);
      setCurrentThought('');
    };

    const handleThinkingChunk = (_chunk: string, accumulated: string) => {
      setCurrentThought(accumulated);
    };

    const handleThinkingComplete = () => {
      setIsThinking(false);
    };

    // Tool invocation events
    const handleToolInvoke = (
      name: string,
      params: Record<string, unknown>,
      phase: 'start' | 'end',
      result?: unknown
    ) => {
      if (phase === 'start') {
        // Add new tool call in running state
        const newToolCall: ToolCall = {
          id: generateToolId(),
          name,
          params,
          status: 'running',
          timestamp: new Date(),
        };
        setToolCalls((prev) => [...prev, newToolCall]);
      } else {
        // Update the most recent matching tool call with result
        setToolCalls((prev) => {
          // Find last matching index (ES2023 findLastIndex polyfill)
          let lastMatchIndex = -1;
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].name === name && prev[i].status === 'running') {
              lastMatchIndex = i;
              break;
            }
          }
          if (lastMatchIndex === -1) return prev;

          const updated = [...prev];
          const resultObj = result as { error?: string } | undefined;
          updated[lastMatchIndex] = {
            ...updated[lastMatchIndex],
            status: resultObj?.error ? 'error' : 'complete',
            result: resultObj?.error ? undefined : result,
            error: resultObj?.error,
          };
          return updated;
        });
      }
    };

    agent.on('state:change', handleStateChange);
    agent.on('journal:entry', handleJournalEntry);
    agent.on('run:complete', handleRunComplete);
    agent.on('run:start', handleRunStart);
    agent.on('thinking:start', handleThinkingStart);
    agent.on('thinking:chunk', handleThinkingChunk);
    agent.on('thinking:complete', handleThinkingComplete);
    agent.on('tool:invoke', handleToolInvoke);

    // Queue events
    if (queue) {
      const updateQueueStats = async () => {
        const stats = await queue.getStats();
        setQueueStats(stats);
      };

      queue.on('task:added', updateQueueStats);
      queue.on('task:completed', updateQueueStats);
      queue.on('task:failed', updateQueueStats);
    }

    // Initial data load
    loadData();

    // Uptime timer
    const uptimeInterval = setInterval(() => {
      setUptime(agent.getUptime());
    }, 1000);

    // Periodic refresh for stats
    const refreshInterval = setInterval(() => {
      loadData();
    }, 5000);

    return () => {
      agent.removeListener('state:change', handleStateChange);
      agent.removeListener('journal:entry', handleJournalEntry);
      agent.removeListener('run:complete', handleRunComplete);
      agent.removeListener('run:start', handleRunStart);
      agent.removeListener('thinking:start', handleThinkingStart);
      agent.removeListener('thinking:chunk', handleThinkingChunk);
      agent.removeListener('thinking:complete', handleThinkingComplete);
      agent.removeListener('tool:invoke', handleToolInvoke);
      clearInterval(uptimeInterval);
      clearInterval(refreshInterval);
    };
  }, [agent, queue, loadData, generateToolId]);

  // Run a message through the agent
  const runMessage = useCallback(async (message: string) => {
    if (isRunning) {
      return;
    }

    setIsRunning(true);
    setLastResponse(null);
    setToolCalls([]); // Clear tool calls for new message

    try {
      const result = await agent.run(message);
      setLastResult(result);
      // Show response or error message
      if (result.success && result.response) {
        setLastResponse(result.response);
      } else if (result.error) {
        setLastResponse(`Error: ${result.error}`);
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      setLastResponse(`Error: ${err}`);
    } finally {
      setIsRunning(false);
    }
  }, [agent, isRunning]);

  return {
    state,
    uptime,
    isRunning,
    isThinking,
    currentThought,
    memoryStats,
    queueStats,
    recentJournal,
    lastResponse,
    lastResult,
    toolCalls,
    runMessage,
    refresh: loadData,
    clearToolCalls,
  };
}
