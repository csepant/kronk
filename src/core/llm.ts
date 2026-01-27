/**
 * Kronk LLM Providers
 *
 * Implementations for LLM completions supporting various backends.
 */

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
 * OpenAI-compatible LLM provider
 * Works with OpenAI API and compatible endpoints (Azure, local proxies, etc.)
 */
export class OpenAILLM implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private temperature: number;
  private maxTokens: number;

  constructor(options: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'gpt-4o';
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
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
    toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
    tokensUsed: number;
  }> {
    const temperature = options?.temperature ?? this.temperature;
    const maxTokens = options?.maxTokens ?? this.maxTokens;

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature,
      max_completion_tokens: maxTokens,
    };

    // Add tools if provided
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

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${error}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            function: {
              name: string;
              arguments: string;
            };
          }>;
        };
      }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const choice = data.choices[0];

    // Parse tool calls if present
    let toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> | undefined;
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      toolCalls = choice.message.tool_calls.map((tc) => ({
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));
    }

    return {
      content: choice.message.content ?? '',
      toolCalls,
      tokensUsed: data.usage.total_tokens,
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

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature,
      max_completion_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
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

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${await response.text()}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let totalTokens = 0;
    const toolCallsInProgress: Map<number, { name: string; arguments: string }> = new Map();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        if (jsonStr === '[DONE]') continue;

        try {
          const data = JSON.parse(jsonStr) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index: number;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
            usage?: { total_tokens: number };
          };

          const delta = data.choices?.[0]?.delta;
          if (delta?.content) {
            yield { type: 'chunk', content: delta.content };
          }

          // Handle streaming tool calls
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = toolCallsInProgress.get(tc.index);
              if (!existing) {
                toolCallsInProgress.set(tc.index, {
                  name: tc.function?.name ?? '',
                  arguments: tc.function?.arguments ?? '',
                });
              } else {
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              }
            }
          }

          if (data.usage) {
            totalTokens = data.usage.total_tokens;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Emit completed tool calls
    for (const tc of toolCallsInProgress.values()) {
      if (tc.name && tc.arguments) {
        try {
          yield {
            type: 'tool_call',
            toolCall: { name: tc.name, arguments: JSON.parse(tc.arguments) },
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
 * Anthropic Claude LLM provider
 */
export class AnthropicLLM implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private temperature: number;
  private maxTokens: number;

  constructor(options: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'claude-sonnet-4-20250514';
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
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

    // Extract system message if present
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      temperature,
      messages: conversationMessages,
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }

    // Add tools if provided
    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.schema,
      }));
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${error}`);
    }

    const data = (await response.json()) as {
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      >;
      usage: {
        input_tokens: number;
        output_tokens: number;
      };
    };

    // Extract text content and tool uses
    let content = '';
    const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

    for (const block of data.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          name: block.name,
          arguments: block.input,
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed: data.usage.input_tokens + data.usage.output_tokens,
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

    const systemMessage = messages.find((m) => m.role === 'system');
    const conversationMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      temperature,
      messages: conversationMessages,
      stream: true,
    };

    if (systemMessage) {
      body.system = systemMessage.content;
    }

    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.schema,
      }));
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${await response.text()}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let totalTokens = 0;
    let currentToolUse: { name: string; inputJson: string } | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);

        try {
          const event = JSON.parse(jsonStr) as {
            type: string;
            index?: number;
            delta?: { type: string; text?: string; partial_json?: string };
            content_block?: { type: string; name?: string };
            message?: { usage?: { input_tokens: number; output_tokens: number } };
            usage?: { input_tokens?: number; output_tokens?: number };
          };

          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            currentToolUse = { name: event.content_block.name ?? '', inputJson: '' };
          } else if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'text_delta' && event.delta.text) {
              yield { type: 'chunk', content: event.delta.text };
            } else if (event.delta?.type === 'input_json_delta' && event.delta.partial_json && currentToolUse) {
              currentToolUse.inputJson += event.delta.partial_json;
            }
          } else if (event.type === 'content_block_stop' && currentToolUse) {
            try {
              yield {
                type: 'tool_call',
                toolCall: { name: currentToolUse.name, arguments: JSON.parse(currentToolUse.inputJson || '{}') },
              };
            } catch {
              // Ignore malformed tool calls
            }
            currentToolUse = null;
          } else if (event.type === 'message_delta' && event.usage) {
            totalTokens = (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0);
          } else if (event.type === 'message_stop') {
            // End of message
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

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
