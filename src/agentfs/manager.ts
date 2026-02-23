/**
 * AgentFS Manager
 *
 * Wraps the AgentFS SDK to provide copy-on-write filesystem sandboxing.
 * Files are read from the real filesystem on first access (lazy-loaded),
 * all writes go to the SQLite-backed virtual FS, and changes can be
 * committed back to the real filesystem or discarded.
 */

import { AgentFS as AgentFSClient } from 'agentfs-sdk';
import { readFile, writeFile, mkdir, stat, readdir, unlink, rm, access, constants } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import type { AgentFSConfig, FileChange, CommitResult } from './types.js';

export class AgentFSManager {
  private client: Awaited<ReturnType<typeof AgentFSClient.open>> | null = null;
  private config: AgentFSConfig;
  /** Track files we've loaded from real FS into the sandbox */
  private loadedPaths = new Set<string>();
  /** Track paths that were written/created in the sandbox */
  private writtenPaths = new Set<string>();
  /** Track paths that were deleted in the sandbox */
  private deletedPaths = new Set<string>();
  /** Track directories created in the sandbox */
  private createdDirs = new Set<string>();

  constructor(config: AgentFSConfig) {
    this.config = config;
  }

  /**
   * Initialize the AgentFS client
   */
  async initialize(): Promise<void> {
    this.client = await AgentFSClient.open({
      id: this.config.agentId,
      path: this.config.dbPath,
    });
  }

  /**
   * Check if AgentFS is enabled and initialized
   */
  isEnabled(): boolean {
    return this.config.enabled && this.client !== null;
  }

  /**
   * Check if the `agentfs` CLI is installed
   */
  static async detectCli(): Promise<boolean> {
    try {
      const { execSync } = await import('node:child_process');
      execSync('agentfs --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the shell prefix for sandboxing commands via the agentfs CLI.
   * Returns null if the CLI is not available.
   */
  async getShellPrefix(): Promise<string | null> {
    const hasCli = await AgentFSManager.detectCli();
    if (!hasCli) return null;
    return `agentfs run --db ${this.config.dbPath} --`;
  }

  /**
   * Resolve a path relative to basePath, normalizing it
   */
  private resolvePath(filePath: string): string {
    if (filePath.startsWith('/')) return filePath;
    return resolve(this.config.basePath, filePath);
  }

  /**
   * Get a virtual FS path (always absolute, rooted at /)
   */
  private toVirtualPath(filePath: string): string {
    const resolved = this.resolvePath(filePath);
    // Use the absolute path as-is in the virtual FS
    return resolved;
  }

  /**
   * Ensure a file from the real FS is loaded into the sandbox on first access
   */
  private async ensureLoaded(filePath: string): Promise<boolean> {
    const virtualPath = this.toVirtualPath(filePath);
    if (this.loadedPaths.has(virtualPath) || this.writtenPaths.has(virtualPath)) {
      return true;
    }

    const realPath = this.resolvePath(filePath);
    try {
      await access(realPath, constants.R_OK);
      const content = await readFile(realPath);
      await this.client!.fs.writeFile(virtualPath, content);
      this.loadedPaths.add(virtualPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a file through the sandbox overlay.
   * If the file hasn't been loaded yet, loads it from the real FS first.
   */
  async readFile(filePath: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    if (!this.isEnabled()) {
      // Fallback to direct FS
      const resolved = this.resolvePath(filePath);
      return encoding ? readFile(resolved, encoding) : readFile(resolved);
    }

    const virtualPath = this.toVirtualPath(filePath);

    // Check if deleted
    if (this.deletedPaths.has(virtualPath)) {
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    }

    // Ensure loaded from real FS
    await this.ensureLoaded(filePath);

    try {
      if (encoding) {
        return await this.client!.fs.readFile(virtualPath, encoding);
      }
      return await this.client!.fs.readFile(virtualPath);
    } catch {
      throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    }
  }

  /**
   * Write a file to the sandbox delta layer (does NOT touch real FS)
   */
  async writeFile(filePath: string, content: string | Buffer): Promise<void> {
    if (!this.isEnabled()) {
      const resolved = this.resolvePath(filePath);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content);
      return;
    }

    const virtualPath = this.toVirtualPath(filePath);
    await this.client!.fs.writeFile(virtualPath, content);
    this.writtenPaths.add(virtualPath);
    this.deletedPaths.delete(virtualPath);
  }

  /**
   * List directory contents through the sandbox overlay
   */
  async readdir(dirPath: string): Promise<string[]> {
    if (!this.isEnabled()) {
      const resolved = this.resolvePath(dirPath);
      return readdir(resolved);
    }

    const virtualPath = this.toVirtualPath(dirPath);

    // Merge real FS listing with virtual FS listing
    const realPath = this.resolvePath(dirPath);
    const realEntries = new Set<string>();
    try {
      const entries = await readdir(realPath);
      for (const e of entries) realEntries.add(e);
    } catch {
      // Directory may not exist on real FS
    }

    // Get virtual entries
    const virtualEntries = new Set<string>();
    try {
      const entries = await this.client!.fs.readdir(virtualPath);
      for (const e of entries) virtualEntries.add(e);
    } catch {
      // Directory may not exist in virtual FS
    }

    // Merge: all real + all virtual, minus deleted
    const merged = new Set([...realEntries, ...virtualEntries]);

    // Remove deleted entries
    for (const deleted of this.deletedPaths) {
      const parentVirtual = this.toVirtualPath(dirPath);
      if (dirname(deleted) === parentVirtual) {
        const name = deleted.split('/').pop()!;
        merged.delete(name);
      }
    }

    return [...merged].sort();
  }

  /**
   * Create a directory in the sandbox
   */
  async mkdir(dirPath: string): Promise<void> {
    if (!this.isEnabled()) {
      const resolved = this.resolvePath(dirPath);
      await mkdir(resolved, { recursive: true });
      return;
    }

    const virtualPath = this.toVirtualPath(dirPath);
    // Create the full path recursively by creating each segment
    const parts = virtualPath.split('/').filter(Boolean);
    let current = '/';
    for (const part of parts) {
      current = join(current, part);
      try {
        await this.client!.fs.mkdir(current);
      } catch {
        // Already exists, ignore
      }
    }
    this.createdDirs.add(virtualPath);
  }

  /**
   * Get file stats through the sandbox overlay
   */
  async stat(filePath: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
    if (!this.isEnabled()) {
      const resolved = this.resolvePath(filePath);
      const s = await stat(resolved);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    }

    const virtualPath = this.toVirtualPath(filePath);

    if (this.deletedPaths.has(virtualPath)) {
      throw new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
    }

    // Try virtual FS first (catches written files)
    try {
      const s = await this.client!.fs.stat(virtualPath);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    } catch {
      // Fall through to real FS check
    }

    // Try real FS
    const realPath = this.resolvePath(filePath);
    try {
      const s = await stat(realPath);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    } catch {
      throw new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
    }
  }

  /**
   * Delete a file in the sandbox (marks as deleted, doesn't touch real FS)
   */
  async unlink(filePath: string): Promise<void> {
    if (!this.isEnabled()) {
      const resolved = this.resolvePath(filePath);
      await unlink(resolved);
      return;
    }

    const virtualPath = this.toVirtualPath(filePath);
    try {
      await this.client!.fs.unlink(virtualPath);
    } catch {
      // May not exist in virtual FS
    }
    this.deletedPaths.add(virtualPath);
    this.writtenPaths.delete(virtualPath);
  }

  /**
   * Remove a directory in the sandbox
   */
  async rmdir(dirPath: string): Promise<void> {
    if (!this.isEnabled()) {
      const resolved = this.resolvePath(dirPath);
      await rm(resolved, { recursive: true });
      return;
    }

    const virtualPath = this.toVirtualPath(dirPath);
    try {
      await this.client!.fs.rmdir(virtualPath);
    } catch {
      // May not exist in virtual FS
    }
    this.deletedPaths.add(virtualPath);
    this.createdDirs.delete(virtualPath);
  }

  /**
   * List all pending changes in the sandbox
   */
  listChanges(): FileChange[] {
    const changes: FileChange[] = [];

    // Written files are either created or modified
    for (const virtualPath of this.writtenPaths) {
      const relativePath = relative(this.config.basePath, virtualPath) || virtualPath;
      const isNew = !this.loadedPaths.has(virtualPath);
      changes.push({
        path: relativePath,
        type: isNew ? 'created' : 'modified',
        size: 0, // Size will be populated lazily if needed
      });
    }

    // Deleted files
    for (const virtualPath of this.deletedPaths) {
      const relativePath = relative(this.config.basePath, virtualPath) || virtualPath;
      changes.push({
        path: relativePath,
        type: 'deleted',
        size: 0,
      });
    }

    return changes;
  }

  /**
   * Commit sandbox changes to the real filesystem
   */
  async commitChanges(): Promise<CommitResult> {
    const result: CommitResult = {
      committed: 0,
      paths: [],
      errors: [],
    };

    if (!this.isEnabled()) return result;

    // Commit written files
    for (const virtualPath of this.writtenPaths) {
      const realPath = virtualPath; // Virtual paths are absolute real paths
      try {
        const content = await this.client!.fs.readFile(virtualPath);
        await mkdir(dirname(realPath), { recursive: true });
        await writeFile(realPath, content);
        result.committed++;
        result.paths.push(relative(this.config.basePath, realPath) || realPath);
      } catch (err) {
        result.errors.push({
          path: relative(this.config.basePath, realPath) || realPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Commit created directories (that weren't already created by file commits)
    for (const virtualPath of this.createdDirs) {
      const realPath = virtualPath;
      try {
        await mkdir(realPath, { recursive: true });
      } catch {
        // Ignore - may already exist from file commits
      }
    }

    // Commit deletions
    for (const virtualPath of this.deletedPaths) {
      const realPath = virtualPath;
      try {
        await rm(realPath, { force: true, recursive: true });
        result.committed++;
        result.paths.push(relative(this.config.basePath, realPath) || realPath);
      } catch (err) {
        result.errors.push({
          path: relative(this.config.basePath, realPath) || realPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /**
   * Discard all sandbox changes and reset the delta layer
   */
  async discardChanges(): Promise<void> {
    this.writtenPaths.clear();
    this.deletedPaths.clear();
    this.loadedPaths.clear();
    this.createdDirs.clear();

    // Close and reinitialize to get a fresh database
    if (this.client) {
      await this.client.close();
    }

    // Remove and recreate the database
    try {
      const { unlink: unlinkFs } = await import('node:fs/promises');
      await unlinkFs(this.config.dbPath);
    } catch {
      // DB file may not exist
    }

    await this.initialize();
  }

  /**
   * Get the number of pending changes
   */
  getPendingChangeCount(): number {
    return this.writtenPaths.size + this.deletedPaths.size;
  }

  /**
   * Shutdown the AgentFS manager
   */
  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}
