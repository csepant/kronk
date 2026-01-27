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

export interface KronkConfig {
  /** Name of this agent instance */
  name: string;
  /** Model to use for LLM calls */
  model: string;
  /** API base URL (for local models or custom endpoints) */
  apiBaseUrl?: string;
  /** Embedding model */
  embeddingModel: string;
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
}

export const DEFAULT_CONFIG: KronkConfig = {
  name: 'kronk-agent',
  model: 'claude-sonnet-4-20250514',
  embeddingModel: 'text-embedding-3-small',
  debug: false,
};

export interface KronkInstance {
  config: KronkConfig;
  db: KronkDatabase;
  memory: MemoryManager;
  tools: ToolsManager;
  journal: JournalManager;
  paths: {
    root: string;
    db: string;
    constitution: string;
    config: string;
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
  const db = createLocalDb(paths.db);
  await db.initialize();
  console.log(`[Kronk] Initialized database: ${paths.db}`);

  // Create managers
  const memory = new MemoryManager(db);
  const tools = new ToolsManager(db);
  const journal = new JournalManager(db);

  // Store constitution as system2 memory
  await memory.store({
    tier: 'system2',
    content: constitution,
    summary: 'Agent constitution: core principles and guidelines',
    importance: 1.0,
    source: 'agent',
    tags: ['constitution', 'identity', 'core'],
  });

  console.log(`[Kronk] ✓ Agent initialized successfully`);
  console.log(`[Kronk] Run 'kronk status' to view your agent`);

  return {
    config,
    db,
    memory,
    tools,
    journal,
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
  };

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
  const db = createLocalDb(paths.db);
  await db.initialize();

  // Create managers
  const memory = new MemoryManager(db);
  const tools = new ToolsManager(db);
  const journal = new JournalManager(db);

  return {
    config,
    db,
    memory,
    tools,
    journal,
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
