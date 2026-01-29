/**
 * Notify Tool Handler
 *
 * Allows the agent to proactively send notifications to the user.
 * Supports desktop notifications, terminal output, and sound alerts.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ToolSchema, ToolHandler } from '../manager.js';

export const notifyToolSchema: ToolSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Notification title (short, attention-grabbing)',
    },
    message: {
      type: 'string',
      description: 'The message to send to the user',
    },
    urgency: {
      type: 'string',
      enum: ['low', 'normal', 'critical'],
      description: 'Urgency level (default: normal). Critical plays a sound.',
    },
    sound: {
      type: 'boolean',
      description: 'Play a sound alert (default: false, true for critical)',
    },
  },
  required: ['message'],
};

export interface NotifyResult {
  sent: boolean;
  method: 'desktop' | 'terminal' | 'both';
  title: string;
  message: string;
  urgency: string;
}

export interface NotifyEvent {
  title: string;
  message: string;
  urgency: string;
  timestamp: Date;
}

/**
 * Create a notify tool handler
 */
export function createNotifyHandler(emitter: EventEmitter): ToolHandler {
  return async (params: Record<string, unknown>): Promise<NotifyResult> => {
    const message = params.message as string;
    const title = (params.title as string) || 'Kronk';
    const urgency = (params.urgency as string) || 'normal';
    const playSound = (params.sound as boolean) ?? urgency === 'critical';

    // Emit event for UI to handle
    emitter.emit('notify', {
      title,
      message,
      urgency,
      timestamp: new Date(),
    } as NotifyEvent);

    // Try desktop notification (macOS)
    let desktopSent = false;
    try {
      desktopSent = await sendDesktopNotification(title, message, playSound);
    } catch {
      // Desktop notification failed, continue with terminal
    }

    // Always log to terminal as well
    const terminalSent = sendTerminalNotification(title, message, urgency, playSound);

    return {
      sent: desktopSent || terminalSent,
      method: desktopSent && terminalSent ? 'both' : desktopSent ? 'desktop' : 'terminal',
      title,
      message,
      urgency,
    };
  };
}

/**
 * Send a desktop notification using osascript (macOS) or notify-send (Linux)
 */
async function sendDesktopNotification(
  title: string,
  message: string,
  playSound: boolean
): Promise<boolean> {
  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS - use osascript
    const soundClause = playSound ? 'sound name "Ping"' : '';
    const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}" ${soundClause}`;

    return new Promise((resolve) => {
      const child = spawn('osascript', ['-e', script]);
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  } else if (platform === 'linux') {
    // Linux - use notify-send
    const urgencyMap: Record<string, string> = {
      low: 'low',
      normal: 'normal',
      critical: 'critical',
    };

    return new Promise((resolve) => {
      const child = spawn('notify-send', [
        '-u',
        urgencyMap[message] || 'normal',
        title,
        message,
      ]);
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  }

  return false;
}

/**
 * Send a terminal notification (writes to stderr with formatting)
 */
function sendTerminalNotification(
  title: string,
  message: string,
  urgency: string,
  playSound: boolean
): boolean {
  const colors = {
    low: '\x1b[36m',      // Cyan
    normal: '\x1b[33m',   // Yellow
    critical: '\x1b[31m', // Red
  };
  const reset = '\x1b[0m';
  const bold = '\x1b[1m';
  const color = colors[urgency as keyof typeof colors] || colors.normal;

  // Bell character for sound
  const bell = playSound ? '\x07' : '';

  const timestamp = new Date().toLocaleTimeString();
  const output = `${bell}\n${color}${bold}🔔 [${title}]${reset} ${color}(${timestamp})${reset}\n   ${message}\n`;

  process.stderr.write(output);
  return true;
}

/**
 * Escape special characters for AppleScript
 */
function escapeAppleScript(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}
