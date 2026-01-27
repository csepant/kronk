/**
 * Kronk TUI - Main Application
 *
 * React-based terminal UI using Ink for interactive agent control.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Dashboard } from './components/Dashboard.js';
import { Chat } from './components/Chat.js';
import { Journal } from './components/Journal.js';
import { Memory } from './components/Memory.js';
import { TaskQueue } from './components/TaskQueue.js';
import { useAgent } from './hooks/useAgent.js';
import type { Agent } from '../core/agent.js';
import type { QueueManager } from '../queue/manager.js';

export type ViewMode = 'dashboard' | 'chat' | 'journal' | 'memory' | 'tasks';

export interface AppProps {
  agent: Agent;
  queue?: QueueManager;
  initialView?: ViewMode;
}

export function App({ agent, queue, initialView = 'dashboard' }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const [view, setView] = useState<ViewMode>(initialView);
  const [showHelp, setShowHelp] = useState(false);
  const agentState = useAgent(agent, queue);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    if (key.escape) {
      if (showHelp) {
        setShowHelp(false);
      } else if (view !== 'dashboard') {
        setView('dashboard');
      }
      return;
    }

    // Only handle view switching when not in chat mode or help is shown
    if (view !== 'chat' || showHelp) {
      switch (input) {
        case '?':
        case 'h':
          setShowHelp(!showHelp);
          break;
        case '1':
          setView('dashboard');
          setShowHelp(false);
          break;
        case '2':
          setView('chat');
          setShowHelp(false);
          break;
        case '3':
          setView('journal');
          setShowHelp(false);
          break;
        case '4':
          setView('memory');
          setShowHelp(false);
          break;
        case '5':
          setView('tasks');
          setShowHelp(false);
          break;
        case 'q':
          if (view === 'dashboard') {
            exit();
          }
          break;
      }
    }
  });

  if (showHelp) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">KRONK - Keyboard Shortcuts</Text>
        </Box>
        <Box flexDirection="column" marginLeft={2}>
          <Text><Text color="yellow">1</Text> - Dashboard view</Text>
          <Text><Text color="yellow">2</Text> - Chat view</Text>
          <Text><Text color="yellow">3</Text> - Journal view</Text>
          <Text><Text color="yellow">4</Text> - Memory view</Text>
          <Text><Text color="yellow">5</Text> - Tasks view</Text>
          <Text><Text color="yellow">h/?</Text> - Toggle help</Text>
          <Text><Text color="yellow">ESC</Text> - Back to dashboard</Text>
          <Text><Text color="yellow">q</Text> - Quit (from dashboard)</Text>
          <Text><Text color="yellow">Ctrl+C</Text> - Force quit</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press any key to close help</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      <Header view={view} state={agentState.state} />

      <Box flexGrow={1}>
        {view === 'dashboard' && (
          <Dashboard
            state={agentState.state}
            uptime={agentState.uptime}
            memoryStats={agentState.memoryStats}
            journalEntries={agentState.recentJournal}
            queueStats={agentState.queueStats}
          />
        )}
        {view === 'chat' && (
          <Chat
            agent={agent}
            onMessage={agentState.runMessage}
            isRunning={agentState.isRunning}
            isThinking={agentState.isThinking}
            currentThought={agentState.currentThought}
            lastResponse={agentState.lastResponse}
          />
        )}
        {view === 'journal' && (
          <Journal entries={agentState.recentJournal} />
        )}
        {view === 'memory' && (
          <Memory stats={agentState.memoryStats} />
        )}
        {view === 'tasks' && queue && (
          <TaskQueue queue={queue} stats={agentState.queueStats} />
        )}
      </Box>

      <Footer view={view} />
    </Box>
  );
}

interface HeaderProps {
  view: ViewMode;
  state: string;
}

function Header({ view, state }: HeaderProps): React.ReactElement {
  const stateColors: Record<string, string> = {
    idle: 'green',
    thinking: 'yellow',
    acting: 'cyan',
    observing: 'blue',
    reflecting: 'magenta',
  };

  const viewNames: Record<ViewMode, string> = {
    dashboard: 'Dashboard',
    chat: 'Chat',
    journal: 'Journal',
    memory: 'Memory',
    tasks: 'Tasks',
  };

  return (
    <Box
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
      justifyContent="space-between"
    >
      <Text bold color="cyan">KRONK</Text>
      <Text> {viewNames[view]} </Text>
      <Box>
        <Text color={stateColors[state] ?? 'white'}>
          {state === 'idle' ? '●' : '◉'} {state}
        </Text>
      </Box>
    </Box>
  );
}

interface FooterProps {
  view: ViewMode;
}

function Footer({ view }: FooterProps): React.ReactElement {
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text dimColor>
        <Text color="yellow">1</Text>-Dashboard{' '}
        <Text color="yellow">2</Text>-Chat{' '}
        <Text color="yellow">3</Text>-Journal{' '}
        <Text color="yellow">4</Text>-Memory{' '}
        <Text color="yellow">5</Text>-Tasks{' '}
        <Text color="yellow">h</Text>-Help
      </Text>
      <Text dimColor>
        {view === 'dashboard' ? 'q-Quit' : 'ESC-Back'}
      </Text>
    </Box>
  );
}
