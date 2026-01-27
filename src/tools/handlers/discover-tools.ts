/**
 * Discover Tools Handler
 *
 * Allows the agent to query and discover available tools dynamically.
 * This is a meta-capability that gives the agent awareness of its tool system.
 */

import type { ToolsManager, Tool, ToolSchema, ToolHandler } from '../manager.js';

export const discoverToolsSchema: ToolSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Search query for tool names/descriptions. Leave empty to list all tools.',
    },
    category: {
      type: 'string',
      description: 'Filter by tool category',
      enum: ['shell', 'file', 'http', 'memory', 'meta', 'all'],
    },
    includeDisabled: {
      type: 'boolean',
      description: 'Include disabled tools in results',
      default: false,
    },
  },
  required: [],
};

export interface DiscoverToolsResult {
  tools: Array<{
    name: string;
    description: string;
    category?: string;
    enabled: boolean;
    parameters: ToolSchema;
  }>;
  totalCount: number;
  query?: string;
  category?: string;
}

/**
 * Create the discover_tools handler
 */
export function createDiscoverToolsHandler(toolsManager: ToolsManager): ToolHandler {
  return async (params: Record<string, unknown>): Promise<DiscoverToolsResult> => {
    const query = (params.query as string) ?? '';
    const category = params.category as string | undefined;
    const includeDisabled = (params.includeDisabled as boolean) ?? false;

    let tools: Tool[];

    if (query) {
      // Search by query
      tools = await toolsManager.search(query, { category, includeDisabled });
    } else if (category && category !== 'all') {
      // List by category
      tools = await toolsManager.listByCategory(category);
    } else if (includeDisabled) {
      // List all including disabled
      tools = await toolsManager.listAll();
    } else {
      // List all enabled
      tools = await toolsManager.listEnabled();
    }

    return {
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        category: (tool.metadata?.category as string) ?? undefined,
        enabled: tool.enabled,
        parameters: tool.schema,
      })),
      totalCount: tools.length,
      query: query || undefined,
      category: category || undefined,
    };
  };
}
