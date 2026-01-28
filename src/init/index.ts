/**
 * Kronk Agent Initialization
 * 
 * Creates the .kronk/ folder structure with:
 * - kronk.db (TursoDB database)
 * - constitution.md (agent guidelines and identity)
 * - config.json (runtime configuration)
 */

import { mkdir, writeFile, readFile, access, constants } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createLocalDb, type KronkDatabase } from '../db/client.js';
import { DEFAULT_CONSTITUTION } from '../db/schema.js';
import { MemoryManager } from '../memory/manager.js';
import { ToolsManager } from '../tools/manager.js';
import { JournalManager } from '../journal/manager.js';
import { MessageManager } from '../messages/manager.js';

export interface KronkConfig {
  /** Name of this agent instance */
  name: string;
  /** LLM provider (ollama, openai, anthropic) */
  provider?: string;
  /** Model to use for LLM calls */
  model: string;
  /** API base URL (for local models or custom endpoints) */
  apiBaseUrl?: string;
  /** Embedding model */
  embeddingModel?: string;
  /** Enable vector search with embeddings (default: false) */
  useVectorSearch: boolean;
  /** Turso cloud URL (optional, for sync) */
  tursoUrl?: string;
  /** Turso auth token */
  tursoAuthToken?: string;
  /** Enable debug logging */
  debug: boolean;
  /** Custom constitution path */
  constitutionPath?: string;
  /** Memory tier token limits (override defaults) */
  memoryLimits?: {
    system2?: number;
    working?: number;
    system1?: number;
  };
  /** Daemon configuration */
  daemon?: {
    /** Auto-start daemon on init */
    autoStart?: boolean;
    /** Socket path override */
    socketPath?: string;
    /** PID file path override */
    pidFile?: string;
  };
  /** Scheduler configuration */
  scheduler?: {
    /** Cron expression for memory decay */
    memoryDecay?: string;
    /** Cron expression for memory cleanup */
    memoryCleanup?: string;
    /** Cron expression for consolidation */
    consolidation?: string;
  };
  /** Queue configuration */
  queue?: {
    /** Maximum concurrent tasks */
    maxConcurrent?: number;
    /** Default retry count */
    defaultRetries?: number;
  };
  /** UI configuration */
  ui?: {
    /** UI theme */
    theme?: string;
    /** Number of journal lines to show */
    journalLines?: number;
  };
}

export const DEFAULT_CONFIG: KronkConfig = {
  name: 'kronk-agent',
  model: 'claude-sonnet-4-20250514',
  useVectorSearch: false,
  debug: false,
};

export interface KronkInstance {
  config: KronkConfig;
  db: KronkDatabase;
  memory: MemoryManager;
  tools: ToolsManager;
  journal: JournalManager;
  messages: MessageManager;
  paths: {
    root: string;
    db: string;
    constitution: string;
    config: string;
    skills: string;
  };
}

/**
 * Check if a path exists
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the .kronk directory path
 */
export function getKronkPath(basePath?: string): string {
  const base = basePath ?? process.cwd();
  return join(resolve(base), '.kronk');
}

/**
 * Get the global .kronk directory in user home
 */
export function getGlobalKronkPath(): string {
  return join(homedir(), '.kronk');
}

/**
 * Initialize a new Kronk agent in the specified directory
 */
export async function init(
  basePath?: string,
  options: {
    config?: Partial<KronkConfig>;
    constitution?: string;
    force?: boolean;
  } = {}
): Promise<KronkInstance> {
  const kronkPath = getKronkPath(basePath);
  const paths = {
    root: kronkPath,
    db: join(kronkPath, 'kronk.db'),
    constitution: join(kronkPath, 'constitution.md'),
    config: join(kronkPath, 'config.json'),
    skills: join(kronkPath, 'skills'),
  };

  // Check if already initialized
  if (await pathExists(kronkPath)) {
    if (!options.force) {
      console.log(`[Kronk] Found existing installation at ${kronkPath}`);
      return load(basePath);
    }
    console.log(`[Kronk] Reinitializing (force mode)...`);
  }

  // Create .kronk directory
  await mkdir(kronkPath, { recursive: true });
  console.log(`[Kronk] Created directory: ${kronkPath}`);

  // Write constitution
  const constitution = options.constitution ?? DEFAULT_CONSTITUTION;
  await writeFile(paths.constitution, constitution, 'utf-8');
  console.log(`[Kronk] Created constitution: ${paths.constitution}`);

  // Write config
  const config: KronkConfig = { ...DEFAULT_CONFIG, ...options.config };
  await writeFile(paths.config, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`[Kronk] Created config: ${paths.config}`);

  // Initialize database
  const db = createLocalDb(paths.db, { useVectorSearch: config.useVectorSearch });
  await db.initialize();
  console.log(`[Kronk] Initialized database: ${paths.db}`);
  console.log(`[Kronk] Vector search: ${config.useVectorSearch ? 'enabled' : 'disabled'}`);

  // Create managers
  const memory = new MemoryManager(db);
  const tools = new ToolsManager(db);
  const journal = new JournalManager(db);
  const messages = new MessageManager(db);

  // Store constitution as system2 memory
  await memory.store({
    tier: 'system2',
    content: constitution,
    summary: 'Agent constitution: core principles and guidelines',
    importance: 1.0,
    source: 'agent',
    tags: ['constitution', 'identity', 'core'],
  });

  // Create skills directory and seed default skills
  await mkdir(paths.skills, { recursive: true });
  await seedDefaultSkills(paths.skills);
  console.log(`[Kronk] Created skills directory: ${paths.skills}`);

  // Seed tool & skill awareness in system2 memory
  await memory.store({
    tier: 'system2',
    content: `I have access to a dynamic tool system. I can discover available tools
using the 'discover_tools' tool. Tools may be added or removed at runtime.
Core tools always available: shell, create_task, create_tool, discover_tools.

I also have access to skills - domain-specific capability documentation stored as
markdown files in the skills directory. I can use 'discover_skills' to list
available skills and 'read_skill' to read their contents. Skills guide me on
how to accomplish tasks in specific domains (e.g., git operations, file management).`,
    summary: 'Tool discovery and skills awareness capabilities',
    importance: 0.9,
    source: 'agent',
    tags: ['capability', 'meta', 'tools', 'skills'],
  });

  console.log(`[Kronk] ✓ Agent initialized successfully`);
  console.log(`[Kronk] Run 'kronk status' to view your agent`);

  return {
    config,
    db,
    memory,
    tools,
    journal,
    messages,
    paths,
  };
}

/**
 * Load an existing Kronk agent from a directory
 */
export async function load(basePath?: string): Promise<KronkInstance> {
  const kronkPath = getKronkPath(basePath);
  const paths = {
    root: kronkPath,
    db: join(kronkPath, 'kronk.db'),
    constitution: join(kronkPath, 'constitution.md'),
    config: join(kronkPath, 'config.json'),
    skills: join(kronkPath, 'skills'),
  };

  // Ensure skills directory exists (for older installations)
  await mkdir(paths.skills, { recursive: true });

  // Verify directory exists
  if (!(await pathExists(kronkPath))) {
    throw new Error(`No Kronk agent found at ${kronkPath}. Run 'kronk init' first.`);
  }

  // Load config
  let config: KronkConfig;
  try {
    const configData = await readFile(paths.config, 'utf-8');
    config = { ...DEFAULT_CONFIG, ...JSON.parse(configData) };
  } catch {
    console.warn('[Kronk] Could not load config, using defaults');
    config = DEFAULT_CONFIG;
  }

  // Connect to database
  const db = createLocalDb(paths.db, { useVectorSearch: config.useVectorSearch });
  await db.initialize();

  // Create managers
  const memory = new MemoryManager(db);
  const tools = new ToolsManager(db);
  const journal = new JournalManager(db);
  const messages = new MessageManager(db);

  return {
    config,
    db,
    memory,
    tools,
    journal,
    messages,
    paths,
  };
}

/**
 * Load the constitution file
 */
export async function loadConstitution(basePath?: string): Promise<string> {
  const constitutionPath = join(getKronkPath(basePath), 'constitution.md');
  return readFile(constitutionPath, 'utf-8');
}

/**
 * Update the constitution file
 */
export async function updateConstitution(content: string, basePath?: string): Promise<void> {
  const constitutionPath = join(getKronkPath(basePath), 'constitution.md');
  await writeFile(constitutionPath, content, 'utf-8');
}

/**
 * Update the config file
 */
export async function updateConfig(
  updates: Partial<KronkConfig>,
  basePath?: string
): Promise<KronkConfig> {
  const configPath = join(getKronkPath(basePath), 'config.json');

  let config: KronkConfig;
  try {
    const existing = await readFile(configPath, 'utf-8');
    config = { ...DEFAULT_CONFIG, ...JSON.parse(existing), ...updates };
  } catch {
    config = { ...DEFAULT_CONFIG, ...updates };
  }

  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return config;
}

/**
 * Check if Kronk is initialized in the given directory
 */
export async function isInitialized(basePath?: string): Promise<boolean> {
  const kronkPath = getKronkPath(basePath);
  return pathExists(kronkPath);
}

/**
 * Get status information about the agent
 */
export async function getStatus(basePath?: string): Promise<{
  initialized: boolean;
  path: string;
  config?: KronkConfig;
  dbStats?: Awaited<ReturnType<KronkDatabase['getStats']>>;
}> {
  const kronkPath = getKronkPath(basePath);
  const initialized = await isInitialized(basePath);

  if (!initialized) {
    return { initialized: false, path: kronkPath };
  }

  try {
    const instance = await load(basePath);
    const dbStats = await instance.db.getStats();

    return {
      initialized: true,
      path: kronkPath,
      config: instance.config,
      dbStats,
    };
  } catch (error) {
    return {
      initialized: true,
      path: kronkPath,
    };
  }
}

// ============================================================================
// Default Skills
// ============================================================================

const DEFAULT_SKILLS: Record<string, string> = {
  'git': `# Git Skill

Version control operations using Git.

## Common Operations

### Status & Information
- \`git status\` - Show working tree status
- \`git log --oneline -n 10\` - Show recent commit history
- \`git diff\` - Show unstaged changes
- \`git diff --staged\` - Show staged changes
- \`git branch -a\` - List all branches

### Making Changes
- \`git add <file>\` - Stage specific file
- \`git add -A\` - Stage all changes
- \`git commit -m "message"\` - Commit staged changes
- \`git commit --amend\` - Amend the last commit

### Branching
- \`git checkout -b <branch>\` - Create and switch to new branch
- \`git checkout <branch>\` - Switch to existing branch
- \`git merge <branch>\` - Merge branch into current
- \`git branch -d <branch>\` - Delete a branch

### Remote Operations
- \`git fetch\` - Fetch from remote
- \`git pull\` - Fetch and merge from remote
- \`git push\` - Push to remote
- \`git push -u origin <branch>\` - Push new branch to remote

### Undoing Changes
- \`git checkout -- <file>\` - Discard changes in file
- \`git reset HEAD <file>\` - Unstage a file
- \`git reset --soft HEAD~1\` - Undo last commit, keep changes staged
- \`git reset --hard HEAD~1\` - Undo last commit, discard changes (caution!)

## Best Practices
- Write clear, descriptive commit messages
- Commit related changes together
- Pull before pushing to avoid conflicts
- Use branches for features and fixes
`,

  'shell': `# Shell Skill

Command-line operations and shell utilities.

## File Operations
- \`ls -la\` - List files with details
- \`cd <dir>\` - Change directory
- \`pwd\` - Print working directory
- \`mkdir -p <dir>\` - Create directory (with parents)
- \`rm <file>\` - Remove file
- \`rm -rf <dir>\` - Remove directory recursively (caution!)
- \`cp <src> <dest>\` - Copy file
- \`mv <src> <dest>\` - Move/rename file
- \`cat <file>\` - Display file contents
- \`head -n <N> <file>\` - Show first N lines
- \`tail -n <N> <file>\` - Show last N lines

## Text Processing
- \`grep <pattern> <file>\` - Search for pattern
- \`grep -r <pattern> <dir>\` - Recursive search
- \`sed 's/old/new/g' <file>\` - Find and replace
- \`awk '{print $1}' <file>\` - Extract columns
- \`sort <file>\` - Sort lines
- \`uniq\` - Remove duplicate lines
- \`wc -l <file>\` - Count lines

## Process Management
- \`ps aux\` - List running processes
- \`kill <pid>\` - Terminate process
- \`top\` / \`htop\` - Monitor processes
- \`bg\` / \`fg\` - Background/foreground jobs

## System Information
- \`df -h\` - Disk usage
- \`du -sh <dir>\` - Directory size
- \`free -h\` - Memory usage
- \`uname -a\` - System info

## Networking
- \`curl <url>\` - HTTP request
- \`wget <url>\` - Download file
- \`ping <host>\` - Test connectivity
- \`netstat -tulpn\` - Show open ports

## Best Practices
- Use absolute paths when possible
- Quote paths with spaces
- Be cautious with rm -rf
- Use && to chain dependent commands
`,

  'file-management': `# File Management Skill

Working with files and directories effectively.

## Reading Files
- Use \`cat\` for small files
- Use \`head\` / \`tail\` for large files
- Use \`less\` for interactive viewing

## Finding Files
- \`find . -name "*.js"\` - Find by name pattern
- \`find . -type f -mtime -1\` - Files modified in last day
- \`find . -type d -name "node_modules"\` - Find directories
- \`locate <name>\` - Fast search (uses index)

## File Permissions
- \`chmod +x <file>\` - Make executable
- \`chmod 644 <file>\` - Standard file permissions
- \`chmod 755 <dir>\` - Standard directory permissions
- \`chown user:group <file>\` - Change ownership

## Archives
- \`tar -czf archive.tar.gz <dir>\` - Create gzipped archive
- \`tar -xzf archive.tar.gz\` - Extract gzipped archive
- \`zip -r archive.zip <dir>\` - Create zip
- \`unzip archive.zip\` - Extract zip

## Disk Usage
- \`du -sh *\` - Size of items in current dir
- \`du -sh * | sort -h\` - Sorted by size
- \`ncdu\` - Interactive disk usage (if installed)

## Best Practices
- Always verify paths before destructive operations
- Use \`-i\` flag for interactive mode (confirms before overwrite)
- Back up important files before modifying
`,

  'npm': `# NPM Skill

Node.js package management with npm.

## Project Setup
- \`npm init\` - Create package.json interactively
- \`npm init -y\` - Create with defaults
- \`npm install\` - Install all dependencies

## Managing Dependencies
- \`npm install <pkg>\` - Install and add to dependencies
- \`npm install -D <pkg>\` - Add to devDependencies
- \`npm install -g <pkg>\` - Install globally
- \`npm uninstall <pkg>\` - Remove package
- \`npm update\` - Update all packages
- \`npm outdated\` - Check for outdated packages

## Running Scripts
- \`npm run <script>\` - Run package.json script
- \`npm start\` - Run start script
- \`npm test\` - Run test script
- \`npm run build\` - Common build script

## Package Info
- \`npm list\` - List installed packages
- \`npm list --depth=0\` - Top-level only
- \`npm info <pkg>\` - Package details
- \`npm search <term>\` - Search registry

## Cache & Troubleshooting
- \`npm cache clean --force\` - Clear cache
- \`rm -rf node_modules && npm install\` - Fresh install
- \`npm ls <pkg>\` - Check why package is installed

## Best Practices
- Lock versions in production (package-lock.json)
- Use exact versions for critical dependencies
- Audit regularly: \`npm audit\`
- Keep dependencies up to date
`,
};

/**
 * Seed default skill files
 */
async function seedDefaultSkills(skillsPath: string): Promise<void> {
  for (const [name, content] of Object.entries(DEFAULT_SKILLS)) {
    const filePath = join(skillsPath, `${name}.md`);
    // Only create if doesn't exist (don't overwrite user customizations)
    if (!(await pathExists(filePath))) {
      await writeFile(filePath, content, 'utf-8');
    }
  }
}
