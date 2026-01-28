/**
 * Shell Confirmation Dialog
 *
 * Interactive Yes/No prompt for shell command approval.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export interface ShellConfirmProps {
  command: string;
  cwd: string;
  onConfirm: (approved: boolean) => void;
}

export function ShellConfirmDialog({ command, cwd, onConfirm }: ShellConfirmProps): React.ReactElement {
  const [selected, setSelected] = useState<'yes' | 'no'>('no');

  useInput((input, key) => {
    if (key.leftArrow || key.rightArrow) {
      setSelected(prev => prev === 'yes' ? 'no' : 'yes');
    }
    if (key.return) {
      onConfirm(selected === 'yes');
    }
    // Allow 'y' and 'n' as shortcuts
    if (input === 'y' || input === 'Y') {
      onConfirm(true);
    }
    if (input === 'n' || input === 'N') {
      onConfirm(false);
    }
  });

  // Truncate command if too long for display
  const displayCommand = command.length > 80 ? command.slice(0, 77) + '...' : command;
  const displayCwd = cwd.length > 50 ? '...' + cwd.slice(-47) : cwd;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      paddingY={1}
    >
      <Text bold color="yellow">Shell Command Confirmation</Text>
      <Box marginTop={1}>
        <Text>Command: </Text>
        <Text color="cyan">{displayCommand}</Text>
      </Box>
      <Box>
        <Text dimColor>Directory: {displayCwd}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Allow execution? </Text>
        <Text color={selected === 'yes' ? 'green' : 'gray'} bold={selected === 'yes'}>
          {selected === 'yes' ? '[Yes]' : ' Yes '}
        </Text>
        <Text> </Text>
        <Text color={selected === 'no' ? 'red' : 'gray'} bold={selected === 'no'}>
          {selected === 'no' ? '[No]' : ' No '}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Left/Right to select, Enter to confirm, or press Y/N</Text>
      </Box>
    </Box>
  );
}
