/**
 * Ask User Form Tool Handler
 *
 * Presents structured multi-choice questions to the user via the TUI.
 * Blocks the agent loop until the user completes the form, similar to shell:confirm.
 */

import { EventEmitter } from 'node:events';
import type { ToolSchema, ToolHandler } from '../manager.js';

export const askUserSchema: ToolSchema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      description: 'Array of question objects. Each object has: title (string, the question text), options (array of {title: string, description: string}), and optional multiSelect (boolean, allows picking multiple options). An "Other..." free-text option is automatically appended.',
      items: { type: 'object' },
    },
  },
  required: ['questions'],
};

export interface FormQuestion {
  title: string;
  options: Array<{ title: string; description: string }>;
  multiSelect?: boolean;
}

export interface FormRequestEvent {
  questions: FormQuestion[];
  resolve: (answers: string[]) => void;
}

export interface AskUserResult {
  success: boolean;
  answers: Array<{ question: string; answer: string }>;
}

/**
 * Create an ask_user tool handler that emits a form:request event and awaits user response
 */
export function createAskUserHandler(emitter: EventEmitter): ToolHandler {
  return async (params: Record<string, unknown>): Promise<AskUserResult> => {
    const questions = params.questions as FormQuestion[];

    const answers = await new Promise<string[]>((resolve) => {
      const hasListeners = emitter.emit('form:request', {
        questions,
        resolve,
      } as FormRequestEvent);

      // If no listeners, return empty answers
      if (!hasListeners) {
        resolve(questions.map(() => ''));
      }
    });

    return {
      success: true,
      answers: questions.map((q, i) => ({
        question: q.title,
        answer: answers[i] ?? '',
      })),
    };
  };
}
