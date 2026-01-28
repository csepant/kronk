/**
 * Journal Tool Handler
 *
 * Allows the agent to intentionally log entries to the journal.
 * Use for decisions, reflections, milestones, and other noteworthy events.
 */

import type { ToolSchema, ToolHandler } from '../manager.js';
import type { JournalManager, JournalEntryType, JournalEntry } from '../../journal/manager.js';

export const journalToolSchema: ToolSchema = {
  type: 'object',
  properties: {
    entry_type: {
      type: 'string',
      enum: ['thought', 'observation', 'reflection', 'decision', 'error', 'milestone'],
      description: 'Type of journal entry. Use reflection for insights, decision for choice rationale, milestone for achievements, error for failures.',
    },
    content: {
      type: 'string',
      description: 'The journal entry content. Be concise but include enough context to be useful later.',
    },
    confidence: {
      type: 'number',
      description: 'Optional confidence level (0-1) for decisions.',
    },
  },
  required: ['entry_type', 'content'],
};

export interface JournalResult {
  success: boolean;
  entry_id: string;
  message: string;
}

/**
 * Create a journal tool handler
 */
export function createJournalHandler(journal: JournalManager): ToolHandler {
  return async (params: Record<string, unknown>): Promise<JournalResult> => {
    const entryType = params.entry_type as JournalEntryType;
    const content = params.content as string;
    const confidence = params.confidence as number | undefined;

    let entry: JournalEntry;

    switch (entryType) {
      case 'thought':
        entry = await journal.thought(content);
        break;
      case 'observation':
        entry = await journal.observation(content);
        break;
      case 'reflection':
        entry = await journal.reflection(content);
        break;
      case 'decision':
        entry = await journal.decision(content, confidence);
        break;
      case 'error':
        entry = await journal.error(content);
        break;
      case 'milestone':
        entry = await journal.milestone(content);
        break;
      default:
        entry = await journal.log({ entryType, content });
    }

    return {
      success: true,
      entry_id: entry.id,
      message: `Logged ${entryType} entry`,
    };
  };
}
