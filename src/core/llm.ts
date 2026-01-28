/**
 * Kronk LLM Providers
 *
 * Implementations for LLM completions supporting various backends.
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, Message, StreamChunk } from './agent.js';
import type { Tool } from '../tools/manager.js';

/**
 * Ollama LLM provider for local models
 */
export class OllamaLLM implements LLMProvider {
  private model: string;
  private baseUrl: string;
  private temperature: number;
  private maxTokens: number;

  constructor(options: {
    model?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
  } = {}) {
    this.model = options.model ?? 'llama3.2';
    this.baseUrl = options.baseUrl ?? 'http://localhost:11434';
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens ?? 4096;
  }

  async complete(
    messages: Message[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      tools?: Tool[];
    }
  ): Promise<{
    content: string;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
    tokensUsed: number;
  }> {
    const temperature = options?.temperature ?? this.temperature;
    const maxTokens = options?.maxTokens ?? this.maxTokens;

    // Convert messages to Ollama format
    const ollamaMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Build request body
    const body: Record<string, unknown> = {
      model: this.model,
      messages: ollamaMessages,
      stream: false,
      options: {
        temperature,
        num_predict: maxTokens,
      },
    };

    // Add tools if provided (Ollama supports function calling in newer versions)
    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.schema,
        },
      }));
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${error}`);
    }

    const data = (await response.json()) as {
      message: {
        role: string;
        content: string;
        tool_calls?: Array<{
          function: {
            name: string;
            arguments: string;
          };
        }>;
      };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    // Parse tool calls if present
    let toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> | undefined;
    if (data.message.tool_calls && data.message.tool_calls.length > 0) {
      toolCalls = data.message.tool_calls.map((tc) => ({
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));
    }

    return {
      content: data.message.content,
      toolCalls,
      tokensUsed: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
    };
  }

  async *completeStream(
    messages: Message[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      tools?: Tool[];
    }
  ): AsyncGenerator<StreamChunk> {
    const temperature = options?.temperature ?? this.temperature;
    const maxTokens = options?.maxTokens ?? this.maxTokens;

    const ollamaMessages = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const body: Record<string, unknown> = {
      model: this.model,
      messages: ollamaMessages,
      stream: true,
      options: {
        temperature,
        num_predict: maxTokens,
      },
    };

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.schema,
        },
      }));
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${await response.text()}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let totalTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const data = JSON.parse(line) as {
            message?: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> };
            done?: boolean;
            prompt_eval_count?: number;
            eval_count?: number;
          };

          if (data.message?.content) {
            yield { type: 'chunk', content: data.message.content };
          }

          if (data.message?.tool_calls) {
            for (const tc of data.message.tool_calls) {
              yield {
                type: 'tool_call',
                toolCall: { name: tc.function.name, arguments: JSON.parse(tc.function.arguments) },
              };
            }
          }

          if (data.done) {
            totalTokens = (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0);
          }
        } catch {
          // Ignore parse errors for partial JSON
        }
      }
    }

    yield { type: 'done', tokensUsed: totalTokens };
  }
}

/**
 * OpenAI-compatible LLM provider using official SDK
 * Works with OpenAI API and compatible endpoints (Azure, local proxies, etc.)
 */
export class OpenAILLM implements LLMProvider {
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(options: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
  }) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
    });
    this.model = options.model ?? 'gpt-4o';
    this.temperature = options.temperature ?? 1;
    this.maxTokens = options.maxTokens ?? 4096;
  }

  async complete(
    messages: Message[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      tools?: Tool[];
    }
  ): Promise<{
    content: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    tokensUsed: number;
  }> {
    const temperature = options?.temperature ?? this.temperature;
    const maxTokens = options?.maxTokens ?? this.maxTokens;

    // Convert messages to OpenAI format
    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map((m) => {
      if (m.role === 'tool' && m.tool_call_id) {
        return {
          role: 'tool' as const,
          tool_call_id: m.tool_call_id,
          content: m.content ?? '',
        };
      }
      if (m.role === 'assistant' && m.tool_calls) {
        return {
          role: 'assistant' as const,
          content: m.content,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
      }
      return {
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content ?? '',
      };
    });

    // Build tools array if provided
    const tools = options?.tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.schema as unknown as Record<string, unknown>,
      },
    }));

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages,
      temperature,
      max_completion_tokens: maxTokens,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    const choice = response.choices[0];

    // Parse tool calls if present
    let toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> | undefined;
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      toolCalls = choice.message.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));
    }

    return {
      content: choice.message.content ?? '',
      toolCalls,
      tokensUsed: response.usage?.total_tokens ?? 0,
    };
  }

  async *completeStream(
    messages: Message[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      tools?: Tool[];
    }
  ): AsyncGenerator<StreamChunk> {
    const temperature = options?.temperature ?? this.temperature;
    const maxTokens = options?.maxTokens ?? this.maxTokens;

    // Convert messages to OpenAI format
    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map((m) => {
      if (m.role === 'tool' && m.tool_call_id) {
        return {
          role: 'tool' as const,
          tool_call_id: m.tool_call_id,
          content: m.content ?? '',
        };
      }
      if (m.role === 'assistant' && m.tool_calls) {
        return {
          role: 'assistant' as const,
          content: m.content,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        };
      }
      return {
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content ?? '',
      };
    });

    // Build tools array if provided
    const tools = options?.tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.schema as unknown as Record<string, unknown>,
      },
    }));

    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: openaiMessages,
      temperature,
      max_completion_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    let totalTokens = 0;
    const toolCallsInProgress: Map<number, { id: string; name: string; arguments: string }> = new Map();

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;

      if (delta?.content) {
        yield { type: 'chunk', content: delta.content };
      }

      // Handle streaming tool calls
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallsInProgress.get(tc.index);
          if (!existing) {
            toolCallsInProgress.set(tc.index, {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? '',
            });
          } else {
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          }
        }
      }

      if (chunk.usage) {
        totalTokens = chunk.usage.total_tokens;
      }
    }

    // Emit completed tool calls
    for (const tc of toolCallsInProgress.values()) {
      if (tc.name && tc.arguments) {
        try {
          yield {
            type: 'tool_call',
            toolCall: { id: tc.id, name: tc.name, arguments: JSON.parse(tc.arguments) },
          };
        } catch {
          // Ignore malformed tool calls
        }
      }
    }

    yield { type: 'done', tokensUsed: totalTokens };
  }
}

/**
 * Anthropic Claude LLM provider using official SDK
 */
export class AnthropicLLM implements LLMProvider {
  private client: Anthropic;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(options: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
  }) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
    });
    this.model = options.model ?? 'claude-sonnet-4-20250514';
    this.temperature = options.temperature ?? 0.7;
    this.maxTokens = options.maxTokens ?? 4096;
  }

  async complete(
    messages: Message[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      tools?: Tool[];
    }
  ): Promise<{
    content: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    tokensUsed: number;
  }> {
    const temperature = options?.temperature ?? this.temperature;
    const maxTokens = options?.maxTokens ?? this.maxTokens;

    // Extract system message if present
    const systemMessage = messages.find((m) => m.role === 'system');

    // Convert messages to Anthropic format
    const anthropicMessages: Anthropic.MessageParam[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;

      if (m.role === 'assistant' && m.tool_calls) {
        // Assistant message with tool use
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.content) {
          content.push({ type: 'text', text: m.content });
        }
        for (const tc of m.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments as Record<string, unknown>,
          });
        }
        anthropicMessages.push({ role: 'assistant', content });
      } else if (m.role === 'tool' && m.tool_call_id) {
        // Tool result message - must be inside a user message
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: m.content ?? '',
          }],
        });
      } else {
        anthropicMessages.push({
          role: m.role as 'user' | 'assistant',
          content: m.content ?? '',
        });
      }
    }

    // Build tools array if provided
    const tools = options?.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.schema as Anthropic.Tool.InputSchema,
    }));

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      temperature,
      ...(systemMessage?.content ? { system: systemMessage.content } : {}),
      messages: anthropicMessages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    // Extract text content and tool uses
    let content = '';
    const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
    };
  }

  async *completeStream(
    messages: Message[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      tools?: Tool[];
    }
  ): AsyncGenerator<StreamChunk> {
    const temperature = options?.temperature ?? this.temperature;
    const maxTokens = options?.maxTokens ?? this.maxTokens;

    // Extract system message if present
    const systemMessage = messages.find((m) => m.role === 'system');

    // Convert messages to Anthropic format
    const anthropicMessages: Anthropic.MessageParam[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;

      if (m.role === 'assistant' && m.tool_calls) {
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.content) {
          content.push({ type: 'text', text: m.content });
        }
        for (const tc of m.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments as Record<string, unknown>,
          });
        }
        anthropicMessages.push({ role: 'assistant', content });
      } else if (m.role === 'tool' && m.tool_call_id) {
        anthropicMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: m.content ?? '',
          }],
        });
      } else {
        anthropicMessages.push({
          role: m.role as 'user' | 'assistant',
          content: m.content ?? '',
        });
      }
    }

    // Build tools array if provided
    const tools = options?.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.schema as Anthropic.Tool.InputSchema,
    }));

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: maxTokens,
      temperature,
      ...(systemMessage?.content ? { system: systemMessage.content } : {}),
      messages: anthropicMessages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    let totalTokens = 0;
    let currentToolUse: { id: string; name: string; inputJson: string } | null = null;

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          currentToolUse = { id: block.id, name: block.name, inputJson: '' };
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          yield { type: 'chunk', content: delta.text };
        } else if (delta.type === 'input_json_delta' && currentToolUse) {
          currentToolUse.inputJson += delta.partial_json;
        }
      } else if (event.type === 'content_block_stop' && currentToolUse) {
        try {
          yield {
            type: 'tool_call',
            toolCall: {
              id: currentToolUse.id,
              name: currentToolUse.name,
              arguments: JSON.parse(currentToolUse.inputJson || '{}'),
            },
          };
        } catch {
          // Ignore malformed tool calls
        }
        currentToolUse = null;
      } else if (event.type === 'message_delta' && event.usage) {
        totalTokens = event.usage.output_tokens;
      }
    }

    // Get final usage from the stream
    const finalMessage = await stream.finalMessage();
    totalTokens = finalMessage.usage.input_tokens + finalMessage.usage.output_tokens;

    yield { type: 'done', tokensUsed: totalTokens };
  }
}

/**
 * Mock LLM provider for testing
 */
export class MockLLM implements LLMProvider {
  private responses: string[];
  private responseIndex: number = 0;

  constructor(responses: string[] = ['This is a mock response.']) {
    this.responses = responses;
  }

  async complete(
    messages: Message[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      tools?: Tool[];
    }
  ): Promise<{
    content: string;
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
    tokensUsed: number;
  }> {
    const response = this.responses[this.responseIndex % this.responses.length];
    this.responseIndex++;

    return {
      content: response,
      tokensUsed: response.length / 4, // Rough estimate
    };
  }

  async *completeStream(
    messages: Message[],
    options?: {
      temperature?: number;
      maxTokens?: number;
      tools?: Tool[];
    }
  ): AsyncGenerator<StreamChunk> {
    const response = this.responses[this.responseIndex % this.responses.length];
    this.responseIndex++;

    // Simulate streaming by emitting words with small delays
    const words = response.split(' ');
    for (let i = 0; i < words.length; i++) {
      const word = words[i] + (i < words.length - 1 ? ' ' : '');
      yield { type: 'chunk', content: word };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    yield { type: 'done', tokensUsed: response.length / 4 };
  }

  /**
   * Set the next response(s) to return
   */
  setResponses(responses: string[]): void {
    this.responses = responses;
    this.responseIndex = 0;
  }
}
