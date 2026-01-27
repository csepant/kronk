/**
 * Skills Handlers
 *
 * Allows the agent to discover and read skill documentation files.
 * Skills are markdown files in .kronk/skills/ that document capabilities
 * for specific domains (e.g., git commands, file operations).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import type { ToolSchema, ToolHandler } from '../manager.js';

// ============================================================================
// discover_skills - List available skills
// ============================================================================

export const discoverSkillsSchema: ToolSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Optional search query to filter skills by name',
    },
  },
  required: [],
};

export interface SkillInfo {
  name: string;
  filename: string;
  description: string;
  sizeBytes: number;
}

export interface DiscoverSkillsResult {
  skills: SkillInfo[];
  totalCount: number;
  skillsPath: string;
  query?: string;
}

/**
 * Extract description from skill markdown (first paragraph after title)
 */
function extractDescription(content: string): string {
  const lines = content.split('\n');
  let foundTitle = false;
  let description = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines before content
    if (!trimmed && !foundTitle) continue;

    // Skip the title line (starts with #)
    if (trimmed.startsWith('#') && !foundTitle) {
      foundTitle = true;
      continue;
    }

    // Skip empty lines after title
    if (!trimmed && foundTitle && !description) continue;

    // Found content - take first paragraph
    if (foundTitle) {
      if (!trimmed && description) break; // End of first paragraph
      description += (description ? ' ' : '') + trimmed;
    }
  }

  // Truncate if too long
  if (description.length > 200) {
    description = description.slice(0, 197) + '...';
  }

  return description || 'No description available';
}

/**
 * Create the discover_skills handler
 */
export function createDiscoverSkillsHandler(skillsPath: string): ToolHandler {
  return async (params: Record<string, unknown>): Promise<DiscoverSkillsResult> => {
    const query = (params.query as string)?.toLowerCase() ?? '';

    try {
      const entries = await readdir(skillsPath, { withFileTypes: true });
      const skills: SkillInfo[] = [];

      for (const entry of entries) {
        if (!entry.isFile() || extname(entry.name) !== '.md') continue;

        const name = basename(entry.name, '.md');

        // Filter by query if provided
        if (query && !name.toLowerCase().includes(query)) continue;

        const filePath = join(skillsPath, entry.name);
        const [content, stats] = await Promise.all([
          readFile(filePath, 'utf-8'),
          stat(filePath),
        ]);

        skills.push({
          name,
          filename: entry.name,
          description: extractDescription(content),
          sizeBytes: stats.size,
        });
      }

      // Sort alphabetically
      skills.sort((a, b) => a.name.localeCompare(b.name));

      return {
        skills,
        totalCount: skills.length,
        skillsPath,
        query: query || undefined,
      };
    } catch (error) {
      // Directory might not exist yet
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          skills: [],
          totalCount: 0,
          skillsPath,
          query: query || undefined,
        };
      }
      throw error;
    }
  };
}

// ============================================================================
// read_skill - Read a specific skill's content
// ============================================================================

export const readSkillSchema: ToolSchema = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Name of the skill to read (without .md extension)',
    },
  },
  required: ['name'],
};

export interface ReadSkillResult {
  name: string;
  content: string;
  sizeBytes: number;
  found: boolean;
  error?: string;
}

/**
 * Create the read_skill handler
 */
export function createReadSkillHandler(skillsPath: string): ToolHandler {
  return async (params: Record<string, unknown>): Promise<ReadSkillResult> => {
    const name = params.name as string;

    if (!name) {
      return {
        name: '',
        content: '',
        sizeBytes: 0,
        found: false,
        error: 'Skill name is required',
      };
    }

    // Sanitize name to prevent directory traversal
    const safeName = basename(name).replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = join(skillsPath, `${safeName}.md`);

    try {
      const [content, stats] = await Promise.all([
        readFile(filePath, 'utf-8'),
        stat(filePath),
      ]);

      return {
        name: safeName,
        content,
        sizeBytes: stats.size,
        found: true,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          name: safeName,
          content: '',
          sizeBytes: 0,
          found: false,
          error: `Skill '${safeName}' not found. Use discover_skills to list available skills.`,
        };
      }
      throw error;
    }
  };
}
