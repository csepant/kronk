/**
 * Markdown Component
 *
 * Renders markdown-formatted text in the terminal using Ink.
 * Supports: code blocks, inline code, bold, italic, headers, and lists.
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface MarkdownProps {
  children: string;
  /** Whether to wrap text */
  wrap?: boolean;
}

interface ParsedBlock {
  type: 'paragraph' | 'code' | 'header' | 'list';
  content: string;
  language?: string;
  level?: number;
}

interface InlineToken {
  type: 'text' | 'code' | 'bold' | 'italic' | 'boldItalic';
  content: string;
}

/**
 * Parse markdown into blocks (code blocks, paragraphs, headers, lists)
 */
function parseBlocks(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const codeMatch = line.match(/^```(\w*)?$/);
    if (codeMatch) {
      const language = codeMatch[1] || '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({
        type: 'code',
        content: codeLines.join('\n'),
        language,
      });
      i++; // Skip closing ```
      continue;
    }

    // Header
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      blocks.push({
        type: 'header',
        content: headerMatch[2],
        level: headerMatch[1].length,
      });
      i++;
      continue;
    }

    // List item
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      blocks.push({
        type: 'list',
        content: listMatch[3],
        level: Math.floor(listMatch[1].length / 2),
      });
      i++;
      continue;
    }

    // Empty line - skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph - collect consecutive non-special lines
    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const currentLine = lines[i];
      if (
        currentLine.trim() === '' ||
        currentLine.match(/^```/) ||
        currentLine.match(/^#{1,6}\s/) ||
        currentLine.match(/^(\s*)([-*+]|\d+\.)\s/)
      ) {
        break;
      }
      paragraphLines.push(currentLine);
      i++;
    }
    if (paragraphLines.length > 0) {
      blocks.push({
        type: 'paragraph',
        content: paragraphLines.join('\n'),
      });
    }
  }

  return blocks;
}

/**
 * Parse inline markdown (bold, italic, code)
 */
function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Inline code (backticks)
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      tokens.push({ type: 'code', content: codeMatch[1] });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Bold+Italic (***text*** or ___text___)
    const boldItalicMatch = remaining.match(/^(\*\*\*|___)(.+?)\1/);
    if (boldItalicMatch) {
      tokens.push({ type: 'boldItalic', content: boldItalicMatch[2] });
      remaining = remaining.slice(boldItalicMatch[0].length);
      continue;
    }

    // Bold (**text** or __text__)
    const boldMatch = remaining.match(/^(\*\*|__)(.+?)\1/);
    if (boldMatch) {
      tokens.push({ type: 'bold', content: boldMatch[2] });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic (*text* or _text_) - be careful not to match **
    const italicMatch = remaining.match(/^(\*|_)(?!\1)(.+?)\1(?!\1)/);
    if (italicMatch) {
      tokens.push({ type: 'italic', content: italicMatch[2] });
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Plain text - find next special character or end
    const nextSpecial = remaining.search(/[`*_]/);
    if (nextSpecial === -1) {
      tokens.push({ type: 'text', content: remaining });
      break;
    } else if (nextSpecial === 0) {
      // Special char that didn't match a pattern, treat as text
      tokens.push({ type: 'text', content: remaining[0] });
      remaining = remaining.slice(1);
    } else {
      tokens.push({ type: 'text', content: remaining.slice(0, nextSpecial) });
      remaining = remaining.slice(nextSpecial);
    }
  }

  return tokens;
}

/**
 * Render inline tokens as Ink Text components
 */
function InlineMarkdown({ text }: { text: string }): React.ReactElement {
  const tokens = parseInline(text);

  return (
    <Text wrap="wrap">
      {tokens.map((token, i) => {
        switch (token.type) {
          case 'code':
            return (
              <Text key={i} color="cyan" backgroundColor="gray">
                {' '}{token.content}{' '}
              </Text>
            );
          case 'bold':
            return (
              <Text key={i} bold>
                {token.content}
              </Text>
            );
          case 'italic':
            return (
              <Text key={i} dimColor>
                {token.content}
              </Text>
            );
          case 'boldItalic':
            return (
              <Text key={i} bold dimColor>
                {token.content}
              </Text>
            );
          default:
            return <Text key={i}>{token.content}</Text>;
        }
      })}
    </Text>
  );
}

/**
 * Render a code block with syntax highlighting hint
 */
function CodeBlock({
  content,
  language,
}: {
  content: string;
  language?: string;
}): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginY={1}
    >
      {language && (
        <Text dimColor italic>
          {language}
        </Text>
      )}
      <Text color="yellow">{content}</Text>
    </Box>
  );
}

/**
 * Main Markdown component
 */
export function Markdown({ children, wrap = true }: MarkdownProps): React.ReactElement {
  if (!children || typeof children !== 'string') {
    return <Text></Text>;
  }

  const blocks = parseBlocks(children);

  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'code':
            return (
              <CodeBlock key={i} content={block.content} language={block.language} />
            );
          case 'header':
            return (
              <Box key={i} marginY={block.level === 1 ? 1 : 0}>
                <Text bold color={block.level === 1 ? 'magenta' : block.level === 2 ? 'blue' : 'white'}>
                  {'#'.repeat(block.level || 1)} {block.content}
                </Text>
              </Box>
            );
          case 'list':
            return (
              <Box key={i} marginLeft={(block.level || 0) * 2}>
                <Text>
                  <Text color="cyan">•</Text> <InlineMarkdown text={block.content} />
                </Text>
              </Box>
            );
          case 'paragraph':
          default:
            return (
              <Box key={i}>
                <InlineMarkdown text={block.content} />
              </Box>
            );
        }
      })}
    </Box>
  );
}
