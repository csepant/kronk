/**
 * Form Dialog Component
 *
 * Multi-question form for the ask_user tool.
 * Shows one question at a time with selectable options and a free-text "Other" fallback.
 * Supports single-select (default) and multi-select questions.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { FormQuestion } from '../../tools/handlers/form.js';

export interface FormDialogProps {
  questions: FormQuestion[];
  onSubmit: (answers: string[]) => void;
}

type Phase = 'answering' | 'summary';

export function FormDialog({ questions, onSubmit }: FormDialogProps): React.ReactElement {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [selectedOption, setSelectedOption] = useState(0);
  const [checkedOptions, setCheckedOptions] = useState<Set<number>>(new Set());
  const [isOtherActive, setIsOtherActive] = useState(false);
  const [otherText, setOtherText] = useState('');
  const [otherTexts, setOtherTexts] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('answering');
  const [summarySelected, setSummarySelected] = useState<'submit' | 'back'>('submit');

  const question = questions[currentIndex];
  const isMultiSelect = question?.multiSelect ?? false;
  // Options count includes the "Other..." entry
  const optionCount = question ? question.options.length + 1 : 0;
  const otherIndex = question ? question.options.length : 0;

  const advanceToNext = (answer: string) => {
    const newAnswers = [...answers, answer];
    if (currentIndex < questions.length - 1) {
      setAnswers(newAnswers);
      setCurrentIndex(currentIndex + 1);
      setSelectedOption(0);
      setCheckedOptions(new Set());
      setIsOtherActive(false);
      setOtherText('');
      setOtherTexts([]);
    } else {
      setAnswers(newAnswers);
      setPhase('summary');
      setSummarySelected('submit');
    }
  };

  const confirmMultiSelect = () => {
    if (!question) return;
    const selected: string[] = [];
    for (const idx of Array.from(checkedOptions).sort((a, b) => a - b)) {
      if (idx < question.options.length) {
        selected.push(question.options[idx].title);
      }
    }
    selected.push(...otherTexts);
    advanceToNext(selected.join(', '));
  };

  useInput((input, key) => {
    if (phase === 'summary') {
      if (key.leftArrow || key.rightArrow) {
        setSummarySelected((prev) => (prev === 'submit' ? 'back' : 'submit'));
      }
      if (key.return) {
        if (summarySelected === 'submit') {
          onSubmit(answers);
        } else {
          // Go back to last question
          setPhase('answering');
          setCurrentIndex(questions.length - 1);
          setAnswers(answers.slice(0, -1));
          setSelectedOption(0);
          setCheckedOptions(new Set());
          setIsOtherActive(false);
          setOtherText('');
          setOtherTexts([]);
        }
      }
      return;
    }

    // Answering phase — text input active
    if (isOtherActive) {
      if (key.escape) {
        setIsOtherActive(false);
        setOtherText('');
        return;
      }
      // TextInput handles the rest
      return;
    }

    if (key.upArrow) {
      setSelectedOption((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedOption((prev) => Math.min(optionCount - 1, prev + 1));
    } else if (isMultiSelect) {
      // Multi-select: Space toggles checkbox, Enter confirms selection
      if (input === ' ') {
        if (selectedOption === otherIndex) {
          setIsOtherActive(true);
        } else {
          setCheckedOptions((prev) => {
            const next = new Set(prev);
            if (next.has(selectedOption)) {
              next.delete(selectedOption);
            } else {
              next.add(selectedOption);
            }
            return next;
          });
        }
      } else if (key.return) {
        confirmMultiSelect();
      }
    } else {
      // Single-select: Space or Enter picks immediately
      if (key.return || input === ' ') {
        if (selectedOption === otherIndex) {
          setIsOtherActive(true);
        } else if (question) {
          advanceToNext(question.options[selectedOption].title);
        }
      }
    }
  });

  const handleOtherSubmit = (value: string) => {
    if (!value.trim()) return;
    if (isMultiSelect) {
      setOtherTexts((prev) => [...prev, value.trim()]);
      setIsOtherActive(false);
      setOtherText('');
    } else {
      advanceToNext(value.trim());
    }
  };

  if (phase === 'summary') {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        paddingY={1}
      >
        <Text bold color="cyan">Review Answers</Text>
        <Box flexDirection="column" marginTop={1}>
          {questions.map((q, i) => (
            <Box key={i}>
              <Text dimColor>{q.title} </Text>
              <Text color="green">{answers[i]}</Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text
            color={summarySelected === 'submit' ? 'green' : 'gray'}
            bold={summarySelected === 'submit'}
          >
            {summarySelected === 'submit' ? '[Submit]' : ' Submit '}
          </Text>
          <Text> </Text>
          <Text
            color={summarySelected === 'back' ? 'yellow' : 'gray'}
            bold={summarySelected === 'back'}
          >
            {summarySelected === 'back' ? '[Back]' : ' Back '}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Left/Right to select, Enter to confirm</Text>
        </Box>
      </Box>
    );
  }

  const totalChecked = checkedOptions.size + otherTexts.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={1}
    >
      <Box>
        <Text bold color="cyan">Question {currentIndex + 1}/{questions.length}</Text>
        {isMultiSelect && <Text dimColor> (multi-select)</Text>}
      </Box>
      <Box marginTop={1}>
        <Text bold>{question?.title}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {question?.options.map((opt, i) => {
          const isHighlighted = selectedOption === i;
          const isChecked = checkedOptions.has(i);
          return (
            <Box key={i} flexDirection="column">
              <Box>
                {isMultiSelect ? (
                  <Text color={isHighlighted ? 'cyan' : 'gray'}>
                    {isHighlighted ? '> ' : '  '}
                    {isChecked ? '[x] ' : '[ ] '}
                  </Text>
                ) : (
                  <Text color={isHighlighted ? 'cyan' : 'gray'}>
                    {isHighlighted ? '> ' : '  '}
                  </Text>
                )}
                <Text color={isHighlighted ? 'cyan' : undefined} bold={isHighlighted}>
                  {opt.title}
                </Text>
              </Box>
              {isHighlighted && (
                <Box marginLeft={isMultiSelect ? 8 : 4}>
                  <Text dimColor>{opt.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}
        {/* Other option */}
        <Box flexDirection="column">
          <Box>
            {isMultiSelect ? (
              <Text color={selectedOption === otherIndex ? 'cyan' : 'gray'}>
                {selectedOption === otherIndex ? '> ' : '  '}
                {'   '}
              </Text>
            ) : (
              <Text color={selectedOption === otherIndex ? 'cyan' : 'gray'}>
                {selectedOption === otherIndex ? '> ' : '  '}
              </Text>
            )}
            <Text
              color={selectedOption === otherIndex ? 'cyan' : undefined}
              bold={selectedOption === otherIndex}
            >
              Other...
            </Text>
          </Box>
          {isOtherActive && (
            <Box marginLeft={isMultiSelect ? 8 : 4}>
              <Text color="cyan">&gt; </Text>
              <TextInput
                value={otherText}
                onChange={setOtherText}
                onSubmit={handleOtherSubmit}
                placeholder="Type your answer..."
              />
            </Box>
          )}
          {/* Show added "Other" entries in multi-select */}
          {isMultiSelect && otherTexts.length > 0 && (
            <Box flexDirection="column" marginLeft={isMultiSelect ? 8 : 4}>
              {otherTexts.map((t, i) => (
                <Text key={i} dimColor>+ {t}</Text>
              ))}
            </Box>
          )}
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {isOtherActive
            ? 'Type your answer and press Enter, ESC to cancel'
            : isMultiSelect
              ? `Up/Down navigate, Space toggle, Enter confirm (${totalChecked} selected)`
              : 'Up/Down to navigate, Space/Enter to select'}
        </Text>
      </Box>
    </Box>
  );
}
