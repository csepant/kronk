/**
 * AgentFS Types
 *
 * Types for filesystem sandboxing via AgentFS.
 */

export interface AgentFSConfig {
  /** Whether AgentFS sandboxing is enabled */
  enabled: boolean;
  /** Agent identifier for the AgentFS instance */
  agentId: string;
  /** Path to the AgentFS SQLite database */
  dbPath: string;
  /** Base path for the overlay (cwd where kronk was invoked) */
  basePath: string;
  /** Whether to auto-commit changes on shutdown */
  autoCommit?: boolean;
}

export type FileChangeType = 'created' | 'modified' | 'deleted';

export interface FileChange {
  /** Relative path from basePath */
  path: string;
  /** Type of change */
  type: FileChangeType;
  /** File size in bytes (0 for deleted) */
  size: number;
}

export interface CommitResult {
  /** Number of files committed */
  committed: number;
  /** Paths that were committed */
  paths: string[];
  /** Any errors that occurred */
  errors: Array<{ path: string; error: string }>;
}
