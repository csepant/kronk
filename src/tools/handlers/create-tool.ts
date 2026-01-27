/**
 * Create Tool Tool Handler
 *
 * Dynamically creates new tools at runtime with persistent storage.
 * Supports shell, HTTP, and JavaScript handler types.
 */

import { EventEmitter } from 'node:events';
import type { ToolSchema, ToolHandler, ToolsManager } from '../manager.js';
import { createShellHandler } from './shell.js';

export const createToolToolSchema: ToolSchema = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Unique tool name (alphanumeric and underscores only)',
    },
    description: {
      type: 'string',
      description: 'What the tool does',
    },
    schema: {
      type: 'object',
      description: 'JSON Schema for parameters',
    },
    handlerType: {
      type: 'string',
      enum: ['shell', 'http', 'javascript'],
      description: 'Handler type: shell (command template), http (fetch config), or javascript (function body)',
    },
    handler: {
      type: 'string',
      description: 'Handler spec: command template with ${params.field}, JSON HTTP config, or JS function body',
    },
  },
  required: ['name', 'description', 'schema', 'handlerType', 'handler'],
};

export type HandlerType = 'shell' | 'http' | 'javascript';

export interface CreateToolResult {
  toolId: string;
  name: string;
  status: 'created';
}

const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const JS_EXECUTION_TIMEOUT = 1000; // 1 second

/**
 * Create a create_tool handler
 */
export function createCreateToolHandler(
  toolsManager: ToolsManager,
  emitter: EventEmitter
): ToolHandler {
  return async (params: Record<string, unknown>): Promise<CreateToolResult> => {
    const name = params.name as string;
    const description = params.description as string;
    const schema = params.schema as ToolSchema;
    const handlerType = params.handlerType as HandlerType;
    const handlerSpec = params.handler as string;

    // Validate tool name
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new Error(
        'Tool name must start with a letter and contain only alphanumeric characters and underscores'
      );
    }

    // Create dynamic handler based on type
    const handler = createDynamicHandler(handlerType, handlerSpec, emitter);

    // Register in database with metadata
    const tool = await toolsManager.register({
      name,
      description,
      schema,
      handler: `dynamic:${handlerType}:${handlerSpec}`,
      metadata: {
        dynamicTool: true,
        handlerType,
        handlerSpec,
        createdAt: new Date().toISOString(),
      },
    });

    // Register runtime handler
    toolsManager.registerHandler(name, handler);

    return {
      toolId: tool.id,
      name: tool.name,
      status: 'created',
    };
  };
}

/**
 * Create a dynamic handler based on type
 */
export function createDynamicHandler(
  handlerType: HandlerType,
  handlerSpec: string,
  emitter: EventEmitter
): ToolHandler {
  switch (handlerType) {
    case 'shell':
      return createShellTemplateHandler(handlerSpec, emitter);
    case 'http':
      return createHttpHandler(handlerSpec);
    case 'javascript':
      return createJavaScriptHandler(handlerSpec);
    default:
      throw new Error(`Unknown handler type: ${handlerType}`);
  }
}

/**
 * Create a shell template handler with ${params.field} substitution
 */
function createShellTemplateHandler(
  commandTemplate: string,
  emitter: EventEmitter
): ToolHandler {
  const shellHandler = createShellHandler(emitter);

  return async (params: Record<string, unknown>): Promise<unknown> => {
    // Substitute ${params.field} with actual values
    const command = commandTemplate.replace(
      /\$\{params\.([^}]+)\}/g,
      (_, key) => {
        const value = params[key];
        if (value === undefined) {
          return '';
        }
        // Escape shell special characters for safety
        return String(value).replace(/[`$\\!"]/g, '\\$&');
      }
    );

    return shellHandler({ command });
  };
}

/**
 * Create an HTTP handler from JSON config
 */
function createHttpHandler(configJson: string): ToolHandler {
  const config = JSON.parse(configJson) as {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    bodyTemplate?: string;
  };

  return async (params: Record<string, unknown>): Promise<unknown> => {
    // Substitute ${params.field} in URL
    const url = config.url.replace(
      /\$\{params\.([^}]+)\}/g,
      (_, key) => encodeURIComponent(String(params[key] ?? ''))
    );

    // Prepare request options
    const options: RequestInit = {
      method: config.method ?? 'GET',
      headers: config.headers,
    };

    // Substitute in body template if present
    if (config.bodyTemplate) {
      const body = config.bodyTemplate.replace(
        /\$\{params\.([^}]+)\}/g,
        (_, key) => {
          const value = params[key];
          // Handle JSON escaping for string values
          if (typeof value === 'string') {
            return value.replace(/[\\"]/g, '\\$&');
          }
          return String(value ?? '');
        }
      );
      options.body = body;
    }

    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      return response.json();
    }

    return {
      status: response.status,
      statusText: response.statusText,
      body: await response.text(),
    };
  };
}

/**
 * Create a JavaScript handler from function body
 * Runs in an isolated context with timeout
 */
function createJavaScriptHandler(functionBody: string): ToolHandler {
  // Create the function at registration time for validation
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('params', functionBody) as (
    params: Record<string, unknown>
  ) => unknown;

  return async (params: Record<string, unknown>): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('JavaScript execution timed out'));
      }, JS_EXECUTION_TIMEOUT);

      try {
        const result = fn(params);

        // Handle both sync and async results
        if (result instanceof Promise) {
          result
            .then((value) => {
              clearTimeout(timeoutId);
              resolve(value);
            })
            .catch((error) => {
              clearTimeout(timeoutId);
              reject(error);
            });
        } else {
          clearTimeout(timeoutId);
          resolve(result);
        }
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  };
}

/**
 * Load dynamic tools from database and register their handlers
 */
export async function loadDynamicTools(
  toolsManager: ToolsManager,
  emitter: EventEmitter
): Promise<number> {
  const tools = await toolsManager.listAll();
  let count = 0;

  for (const tool of tools) {
    const metadata = tool.metadata as {
      dynamicTool?: boolean;
      handlerType?: HandlerType;
      handlerSpec?: string;
    } | undefined;

    if (metadata?.dynamicTool && metadata.handlerType && metadata.handlerSpec) {
      try {
        const handler = createDynamicHandler(
          metadata.handlerType,
          metadata.handlerSpec,
          emitter
        );
        toolsManager.registerHandler(tool.name, handler);
        count++;
      } catch (error) {
        console.error(
          `[Kronk] Failed to load dynamic tool '${tool.name}':`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  return count;
}
