/**
 * File Tool Handlers
 *
 * Provides sandboxed file operations via AgentFS.
 * Falls back to direct node:fs/promises when AgentFS is not available.
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ToolSchema, ToolHandler } from '../manager.js';
import type { AgentFSManager } from '../../agentfs/manager.js';

// ── Schemas ─────────────────────────────────────────────────────────────────

export const readFileSchema: ToolSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Path to the file to read (absolute or relative to project root)',
    },
    encoding: {
      type: 'string',
      description: 'Encoding (default: utf-8)',
    },
  },
  required: ['path'],
};

export const writeFileSchema: ToolSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Path to the file to write (absolute or relative to project root)',
    },
    content: {
      type: 'string',
      description: 'Content to write to the file',
    },
  },
  required: ['path', 'content'],
};

export const listDirectorySchema: ToolSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Path to the directory to list (absolute or relative to project root)',
    },
  },
  required: ['path'],
};

export const makeDirectorySchema: ToolSchema = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Path to the directory to create (absolute or relative to project root)',
    },
  },
  required: ['path'],
};

// ── Result types ────────────────────────────────────────────────────────────

export interface ReadFileResult {
  content: string;
  path: string;
  sandboxed: boolean;
}

export interface WriteFileResult {
  path: string;
  bytesWritten: number;
  sandboxed: boolean;
}

export interface ListDirectoryResult {
  entries: string[];
  path: string;
  sandboxed: boolean;
}

export interface MakeDirectoryResult {
  path: string;
  sandboxed: boolean;
}

// ── Handler factories ───────────────────────────────────────────────────────

/**
 * Create a read_file handler
 */
export function createReadFileHandler(
  agentfs: AgentFSManager | null,
  defaultCwd?: string,
): ToolHandler {
  return async (params: Record<string, unknown>): Promise<ReadFileResult> => {
    const filePath = params.path as string;
    const encoding = (params.encoding as BufferEncoding) || 'utf-8';

    if (agentfs?.isEnabled()) {
      const content = await agentfs.readFile(filePath, encoding);
      return {
        content: typeof content === 'string' ? content : content.toString(encoding),
        path: filePath,
        sandboxed: true,
      };
    }

    // Fallback: direct FS
    const resolved = filePath.startsWith('/') ? filePath : resolve(defaultCwd ?? process.cwd(), filePath);
    const content = await readFile(resolved, encoding);
    return {
      content,
      path: filePath,
      sandboxed: false,
    };
  };
}

/**
 * Create a write_file handler
 */
export function createWriteFileHandler(
  agentfs: AgentFSManager | null,
  defaultCwd?: string,
): ToolHandler {
  return async (params: Record<string, unknown>): Promise<WriteFileResult> => {
    const filePath = params.path as string;
    const content = params.content as string;

    if (agentfs?.isEnabled()) {
      await agentfs.writeFile(filePath, content);
      return {
        path: filePath,
        bytesWritten: Buffer.byteLength(content, 'utf-8'),
        sandboxed: true,
      };
    }

    // Fallback: direct FS with warning
    const resolved = filePath.startsWith('/') ? filePath : resolve(defaultCwd ?? process.cwd(), filePath);
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, content, 'utf-8');
    return {
      path: filePath,
      bytesWritten: Buffer.byteLength(content, 'utf-8'),
      sandboxed: false,
    };
  };
}

/**
 * Create a list_directory handler
 */
export function createListDirectoryHandler(
  agentfs: AgentFSManager | null,
  defaultCwd?: string,
): ToolHandler {
  return async (params: Record<string, unknown>): Promise<ListDirectoryResult> => {
    const dirPath = (params.path as string) || '.';

    if (agentfs?.isEnabled()) {
      const entries = await agentfs.readdir(dirPath);
      return {
        entries,
        path: dirPath,
        sandboxed: true,
      };
    }

    // Fallback: direct FS
    const resolved = dirPath.startsWith('/') ? dirPath : resolve(defaultCwd ?? process.cwd(), dirPath);
    const entries = await readdir(resolved);
    return {
      entries,
      path: dirPath,
      sandboxed: false,
    };
  };
}

/**
 * Create a make_directory handler
 */
export function createMakeDirectoryHandler(
  agentfs: AgentFSManager | null,
  defaultCwd?: string,
): ToolHandler {
  return async (params: Record<string, unknown>): Promise<MakeDirectoryResult> => {
    const dirPath = params.path as string;

    if (agentfs?.isEnabled()) {
      await agentfs.mkdir(dirPath);
      return {
        path: dirPath,
        sandboxed: true,
      };
    }

    // Fallback: direct FS
    const resolved = dirPath.startsWith('/') ? dirPath : resolve(defaultCwd ?? process.cwd(), dirPath);
    await mkdir(resolved, { recursive: true });
    return {
      path: dirPath,
      sandboxed: false,
    };
  };
}
