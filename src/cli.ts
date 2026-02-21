#!/usr/bin/env node
/**
 * Kronk CLI
 *
 * Command-line interface for managing Kronk agents.
 */

import { Command } from 'commander';
import { render } from 'ink';
import React from 'react';
import { init, load, getStatus, updateConfig, loadConstitution, getKronkPath, isInitialized } from './init/index.js';
import { MEMORY_TIERS } from './db/schema.js';
import { Agent, type LLMProvider } from './core/agent.js';
import { OpenAIEmbedder, OllamaEmbedder } from './core/embedders.js';
import type { EmbeddingProvider } from './memory/manager.js';
import { OllamaLLM, OpenAILLM, AnthropicLLM } from './core/llm.js';
import { Scheduler } from './core/scheduler.js';
import { QueueManager } from './queue/manager.js';
import { FileWatcher } from './watchers/file.js';
import { Daemon, startDaemonProcess, stopDaemon, getDaemonStatus } from './daemon/index.js';
import { IPCClient, connectToDaemon, isDaemonRunning } from './daemon/client.js';
import { App } from './ui/App.js';

/**
 * Create LLM and optionally Embedder based on environment/config
 */
function createProviders(config?: { model?: string; provider?: string; useVectorSearch?: boolean }): {
  llm: LLMProvider;
  embedder: EmbeddingProvider | undefined;
  provider: string;
} {
  // Check for Ollama settings
  const ollamaUrl = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  const ollamaModel = process.env.OLLAMA_MODEL ?? config?.model ?? 'llama3.2';

  // Check for API keys
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // Determine provider: env var > config > auto-detect
  const requestedProvider = process.env.LLM_PROVIDER ?? config?.provider;

  // Anthropic
  if (requestedProvider === 'anthropic') {
    if (!anthropicKey) {
      console.error('Error: ANTHROPIC_API_KEY environment variable is required for Anthropic provider');
      process.exit(1);
    }

    // Only create embedder if vector search is enabled
    let embedder: EmbeddingProvider | undefined;
    if (config?.useVectorSearch) {
      embedder = openaiKey
        ? new OpenAIEmbedder({ apiKey: openaiKey })
        : new OllamaEmbedder({
            model: process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text',
            baseUrl: ollamaUrl,
          });
    }

    return {
      llm: new AnthropicLLM({
        apiKey: anthropicKey,
        model: config?.model ?? 'claude-sonnet-4-20250514',
      }),
      embedder,
      provider: 'anthropic',
    };
  }

  // OpenAI
  if (requestedProvider === 'openai') {
    if (!openaiKey) {
      console.error('Error: OPENAI_API_KEY environment variable is required for OpenAI provider');
      process.exit(1);
    }

    // Only create embedder if vector search is enabled
    const embedder = config?.useVectorSearch
      ? new OpenAIEmbedder({ apiKey: openaiKey })
      : undefined;

    return {
      llm: new OpenAILLM({
        apiKey: openaiKey,
        model: config?.model ?? 'gpt-4o',
      }),
      embedder,
      provider: 'openai',
    };
  }

  // Ollama (explicit or fallback)
  if (requestedProvider === 'ollama' || !requestedProvider) {
    // Only create embedder if vector search is enabled
    const embedder = config?.useVectorSearch
      ? new OllamaEmbedder({
          model: process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text',
          baseUrl: ollamaUrl,
        })
      : undefined;

    return {
      llm: new OllamaLLM({
        model: ollamaModel,
        baseUrl: ollamaUrl,
      }),
      embedder,
      provider: 'ollama',
    };
  }

  // Unknown provider
  console.error(`Error: Unknown provider "${requestedProvider}". Use: ollama, openai, or anthropic`);
  process.exit(1);
}

const program = new Command();

program
  .name('kronk')
  .description('Agentic AI framework with tiered memory and vector search')
  .version('0.1.0');

// Initialize command
program
  .command('init')
  .description('Initialize a new Kronk agent in the current directory')
  .option('-n, --name <name>', 'Agent name')
  .option('-m, --model <model>', 'LLM model to use')
  .option('-p, --provider <provider>', 'LLM provider (ollama, openai, anthropic)')
  .option('-f, --force', 'Overwrite existing installation')
  .option('--vector-search', 'Enable vector search with embeddings (requires embedding model)')
  .option('--no-interactive', 'Disable interactive wizard')
  .action(async (options) => {
    try {
      // Determine if user passed any config flags
      const hasFlags = options.name || options.model || options.provider || options.force || options.vectorSearch;
      const isTTY = process.stdin.isTTY && process.stdout.isTTY;
      const interactiveDisabled = options.interactive === false; // --no-interactive sets this to false

      // Interactive wizard: no flags provided, TTY available, not disabled
      if (!hasFlags && isTTY && !interactiveDisabled) {
        const existingInstall = await isInitialized();
        const { runInitWizard } = await import('./init/wizard.js');
        const result = await runInitWizard(existingInstall);

        await init(undefined, {
          config: {
            name: result.name,
            model: result.model,
            provider: result.provider,
            useVectorSearch: result.useVectorSearch,
          },
          force: result.force,
        });

        console.log(`\nProvider: ${result.provider}`);
        console.log(`Model: ${result.model}`);
        console.log(`Vector Search: ${result.useVectorSearch ? 'enabled' : 'disabled (text search only)'}`);
        return;
      }

      // Non-interactive path: apply defaults
      const provider = options.provider ?? 'ollama';
      const providerModelDefaults: Record<string, string> = {
        ollama: 'llama3.2',
        openai: 'gpt-4o',
        anthropic: 'claude-sonnet-4-20250514',
      };
      const model = options.model ?? providerModelDefaults[provider] ?? 'llama3.2';
      const name = options.name ?? 'kronk-agent';
      const useVectorSearch = options.vectorSearch ?? false;

      await init(undefined, {
        config: {
          name,
          model,
          provider,
          useVectorSearch,
        },
        force: options.force,
      });

      console.log(`\nProvider: ${provider}`);
      console.log(`Model: ${model}`);
      console.log(`Vector Search: ${useVectorSearch ? 'enabled' : 'disabled (text search only)'}`);

      if (useVectorSearch) {
        console.log('\nNote: Vector search requires an embedding model.');
      }

      if (provider === 'ollama') {
        console.log('\nTo use Ollama, make sure it is running:');
        console.log('  ollama serve');
        console.log(`  ollama pull ${model}`);
      } else if (provider === 'openai') {
        console.log('\nSet your OpenAI API key:');
        console.log('  export OPENAI_API_KEY=your-key');
      } else if (provider === 'anthropic') {
        console.log('\nSet your Anthropic API key:');
        console.log('  export ANTHROPIC_API_KEY=your-key');
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Show agent status and statistics')
  .option('-l, --live', 'Live updating status')
  .action(async (options) => {
    try {
      const kronkPath = getKronkPath();

      if (options.live) {
        // Check if daemon is running
        const daemonStatus = await getDaemonStatus(kronkPath);

        if (daemonStatus.running) {
          const client = await connectToDaemon(daemonStatus.socketPath!);
          await client.subscribe(['agent.state', 'agent.memory', 'queue.*']);

          console.log('\n🤖 Kronk Live Status (Ctrl+C to exit)\n');

          const printStatus = async () => {
            const status = await client.status();
            console.clear();
            console.log('\n🤖 Kronk Live Status (Ctrl+C to exit)\n');
            console.log(`State: ${status.state}`);
            console.log(`Uptime: ${formatUptime(status.uptime)}`);
            console.log(`\nStats:`, JSON.stringify(status.stats, null, 2));
          };

          await printStatus();

          client.on('notification', async (method, params) => {
            console.log(`\n[Event] ${method}:`, JSON.stringify(params).slice(0, 100));
            await printStatus();
          });

          // Keep running
          process.on('SIGINT', async () => {
            await client.disconnect();
            process.exit(0);
          });

          await new Promise(() => {}); // Keep running
        } else {
          console.log('Daemon is not running. Start it with: kronk start');
          console.log('Showing static status instead:\n');
        }
      }

      const status = await getStatus();

      console.log('\n🤖 Kronk Agent Status\n');
      console.log(`Path: ${status.path}`);
      console.log(`Initialized: ${status.initialized ? '✓' : '✗'}`);

      // Check daemon status
      const daemonStatus = await getDaemonStatus(status.path);
      console.log(`Daemon: ${daemonStatus.running ? `Running (PID: ${daemonStatus.pid})` : 'Not running'}`);

      if (status.config) {
        console.log(`\nConfiguration:`);
        console.log(`  Name: ${status.config.name}`);
        console.log(`  Model: ${status.config.model}`);
        console.log(`  Vector Search: ${status.config.useVectorSearch ? 'enabled' : 'disabled (text search)'}`);
        console.log(`  Debug: ${status.config.debug}`);
      }

      if (status.dbStats) {
        console.log(`\nMemory Stats:`);
        console.log(`  System 2 (Long Horizon): ${status.dbStats.memoryCount.system2}`);
        console.log(`  Working Memory: ${status.dbStats.memoryCount.working}`);
        console.log(`  System 1 (Short Term): ${status.dbStats.memoryCount.system1}`);
        console.log(`\nJournal Entries: ${status.dbStats.journalCount}`);
        console.log(`Active Tools: ${status.dbStats.toolCount}`);
      }

      console.log('');
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Daemon commands
program
  .command('start')
  .description('Start the Kronk daemon in the background')
  .option('--provider <provider>', 'LLM provider (ollama, openai, anthropic)')
  .option('--model <model>', 'Model to use')
  .option('--ws-port <port>', 'Enable WebSocket server on specified port')
  .option('--ws-host <host>', 'WebSocket hostname (default: localhost)')
  .option('--ws-origins <origins>', 'Comma-separated allowed CORS origins')
  .action(async (options) => {
    try {
      const kronkPath = getKronkPath();
      const status = await getDaemonStatus(kronkPath);

      if (status.running) {
        console.log(`Daemon is already running (PID: ${status.pid})`);
        return;
      }

      console.log('Starting Kronk daemon...');

      const instance = await load();

      // Override provider if specified
      if (options.provider) {
        process.env.LLM_PROVIDER = options.provider;
      }

      // Create providers
      const { llm, embedder, provider } = createProviders({
        model: options.model ?? instance.config.model,
        provider: options.provider ?? instance.config.provider,
        useVectorSearch: instance.config.useVectorSearch,
      });

      console.log(`Using ${provider} as LLM provider`);
      if (!instance.config.useVectorSearch) {
        console.log('Vector search disabled (using text search)');
      }

      // Build WebSocket config if --ws-port is provided
      const websocket = options.wsPort
        ? {
            port: parseInt(options.wsPort, 10),
            hostname: options.wsHost,
            allowedOrigins: options.wsOrigins
              ? (options.wsOrigins as string).split(',').map((o: string) => o.trim())
              : undefined,
          }
        : undefined;

      const daemon = new Daemon({
        kronkPath,
        websocket,
      });

      await daemon.start({
        llm,
        embedder,
      });

      console.log(`✓ Daemon started (PID: ${process.pid})`);
      console.log(`Socket: ${daemon.getSocketPath()}`);
      if (websocket) {
        console.log(`WebSocket: ws://${websocket.hostname ?? 'localhost'}:${websocket.port}`);
      }
      console.log('\nPress Ctrl+C to stop');

      // Keep running
      await new Promise(() => {});
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop the running Kronk daemon')
  .action(async () => {
    try {
      const kronkPath = getKronkPath();
      const stopped = await stopDaemon(kronkPath);

      if (stopped) {
        console.log('✓ Daemon stopped');
      } else {
        console.log('Daemon is not running');
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('restart')
  .description('Restart the Kronk daemon')
  .action(async () => {
    try {
      const kronkPath = getKronkPath();

      console.log('Stopping daemon...');
      await stopDaemon(kronkPath);

      console.log('Starting daemon...');
      // Re-run start command
      program.parse(['node', 'kronk', 'start']);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// UI command
program
  .command('ui')
  .description('Launch interactive TUI dashboard')
  .option('--provider <provider>', 'LLM provider (ollama, openai, anthropic)')
  .option('--model <model>', 'Model to use')
  .option('--allow-shell', 'Auto-approve shell commands without confirmation')
  .action(async (options) => {
    try {
      const instance = await load();

      // Override provider if specified
      if (options.provider) {
        process.env.LLM_PROVIDER = options.provider;
      }

      // Create providers
      const { llm, embedder, provider } = createProviders({
        model: options.model ?? instance.config.model,
        provider: options.provider ?? instance.config.provider,
        useVectorSearch: instance.config.useVectorSearch,
      });

      console.log(`Using ${provider} as LLM provider`);
      if (!instance.config.useVectorSearch) {
        console.log('Vector search disabled (using text search)');
      }

      const agent = new Agent(instance, { llm, embedder });
      await agent.initialize();

      const queue = new QueueManager(instance.db);

      queue.start();

      // Enter alternate screen buffer for fullscreen UI
      process.stdout.write('\x1b[?1049h');
      process.stdout.write('\x1b[H');

      const { waitUntilExit } = render(
        React.createElement(App, {
          agent,
          queue,
          messageManager: instance.messages,
          allowShell: options.allowShell,
        })
      );

      await waitUntilExit();

      // Exit alternate screen buffer
      process.stdout.write('\x1b[?1049l');

      queue.stop();
      await instance.db.close();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Chat command (simple REPL)
program
  .command('chat')
  .description('Simple REPL chat mode')
  .option('--provider <provider>', 'LLM provider (ollama, openai, anthropic)')
  .option('--model <model>', 'Model to use')
  .option('--allow-shell', 'Auto-approve shell commands without confirmation')
  .action(async (options) => {
    try {
      const kronkPath = getKronkPath();
      const daemonStatus = await getDaemonStatus(kronkPath);

      if (daemonStatus.running) {
        // Connect to daemon
        const client = await connectToDaemon(daemonStatus.socketPath!);
        console.log('🤖 Connected to Kronk daemon. Type "exit" to quit.\n');

        const readline = await import('node:readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const prompt = () => {
          rl.question('> ', async (input) => {
            const trimmed = input.trim();
            if (trimmed === 'exit' || trimmed === 'quit') {
              await client.disconnect();
              rl.close();
              return;
            }

            if (!trimmed) {
              prompt();
              return;
            }

            try {
              console.log('💭 Thinking...');
              const result = await client.run(trimmed) as { response: string };
              console.log(`\n🤖 ${result.response}\n`);
            } catch (error) {
              console.error('Error:', error instanceof Error ? error.message : error);
            }

            prompt();
          });
        };

        prompt();
      } else {
        console.log('Daemon is not running. Starting embedded mode...\n');

        const instance = await load();

        // Override provider if specified
        if (options.provider) {
          process.env.LLM_PROVIDER = options.provider;
        }

        // Create providers
        const { llm, embedder, provider } = createProviders({
          model: options.model ?? instance.config.model,
          provider: options.provider ?? instance.config.provider,
          useVectorSearch: instance.config.useVectorSearch,
        });

        console.log(`Using ${provider} as LLM provider`);
        if (!instance.config.useVectorSearch) {
          console.log('Vector search disabled (using text search)');
        }

        const agent = new Agent(instance, { llm, embedder });
        await agent.initialize();

        // Auto-approve shell commands if --allow-shell flag is set
        if (options.allowShell) {
          agent.on('shell:confirm', (event) => {
            event.resolve(true);
          });
          console.log('Shell auto-approve enabled');
        }

        console.log('🤖 Chat mode. Type "exit" to quit.\n');

        const readline = await import('node:readline');
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        const prompt = () => {
          rl.question('> ', async (input) => {
            const trimmed = input.trim();
            if (trimmed === 'exit' || trimmed === 'quit') {
              await agent.shutdown();
              rl.close();
              return;
            }

            if (!trimmed) {
              prompt();
              return;
            }

            try {
              console.log('💭 Thinking...');
              const result = await agent.run(trimmed);
              console.log(`\n🤖 ${result.response}\n`);
            } catch (error) {
              console.error('Error:', error instanceof Error ? error.message : error);
            }

            prompt();
          });
        };

        prompt();
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Logs command
program
  .command('logs')
  .description('Stream journal entries')
  .option('-f, --follow', 'Follow new entries')
  .option('-n, --lines <number>', 'Number of lines to show', '20')
  .action(async (options) => {
    try {
      const instance = await load();
      const entries = await instance.journal.getRecent(parseInt(options.lines, 10));

      const typeEmojis: Record<string, string> = {
        thought: '💭',
        action: '⚡',
        observation: '👁️',
        reflection: '🪞',
        decision: '⚖️',
        error: '❌',
        milestone: '🎯',
      };

      console.log(`\n📓 Journal Entries (${entries.length})\n`);

      for (const entry of entries.reverse()) {
        const timestamp = entry.createdAt.toISOString().slice(0, 19).replace('T', ' ');
        console.log(`${typeEmojis[entry.entryType]} [${timestamp}] ${entry.entryType.toUpperCase()}`);
        console.log(`   ${entry.content.slice(0, 150)}${entry.content.length > 150 ? '...' : ''}`);
        console.log('');
      }

      if (options.follow) {
        const kronkPath = getKronkPath();
        const daemonStatus = await getDaemonStatus(kronkPath);

        if (daemonStatus.running) {
          const client = await connectToDaemon(daemonStatus.socketPath!);
          await client.subscribe(['agent.journal']);

          console.log('📓 Following new entries (Ctrl+C to stop)...\n');

          client.on('notification', (method, params) => {
            if (method === 'agent.journal') {
              const entry = params.entry as { entryType: string; createdAt: string; content: string };
              const timestamp = new Date(entry.createdAt).toISOString().slice(0, 19).replace('T', ' ');
              console.log(`${typeEmojis[entry.entryType] ?? '•'} [${timestamp}] ${entry.entryType.toUpperCase()}`);
              console.log(`   ${entry.content.slice(0, 150)}${entry.content.length > 150 ? '...' : ''}`);
              console.log('');
            }
          });

          process.on('SIGINT', async () => {
            await client.disconnect();
            process.exit(0);
          });

          await new Promise(() => {});
        } else {
          console.log('Note: Daemon is not running, --follow requires the daemon.');
        }
      }

      await instance.db.close();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Memory commands
const memory = program.command('memory').description('Memory management commands');

memory
  .command('list')
  .description('List memories by tier')
  .option('-t, --tier <tier>', 'Filter by tier (system2, working, system1)')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (options) => {
    try {
      const instance = await load();
      const limit = parseInt(options.limit, 10);

      let query = 'SELECT * FROM memory';
      const args: unknown[] = [];

      if (options.tier) {
        query += ' WHERE tier = ?';
        args.push(options.tier);
      }

      query += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
      args.push(limit);

      const result = await instance.db.query(query, args);

      console.log(`\n📚 Memories (${result.rows.length})\n`);

      for (const row of result.rows) {
        const tier = row.tier as string;
        const tierEmoji = tier === 'system2' ? '🎯' : tier === 'working' ? '⚙️' : '💨';
        console.log(`${tierEmoji} [${tier}] (imp: ${(row.importance as number).toFixed(2)})`);
        console.log(`   ${(row.content as string).slice(0, 100)}...`);
        console.log('');
      }

      await instance.db.close();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

memory
  .command('add <content>')
  .description('Add a memory')
  .option('-t, --tier <tier>', 'Memory tier (system2, working, system1)', 'working')
  .option('-i, --importance <number>', 'Importance score (0-1)', '0.5')
  .action(async (content, options) => {
    try {
      const instance = await load();

      await instance.memory.store({
        tier: options.tier as keyof typeof MEMORY_TIERS,
        content,
        importance: parseFloat(options.importance),
        source: 'user',
      });

      console.log(`✓ Memory added to ${options.tier}`);
      await instance.db.close();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

memory
  .command('stats')
  .description('Show memory statistics')
  .action(async () => {
    try {
      const instance = await load();
      const stats = await instance.memory.getStats();

      console.log('\n📊 Memory Statistics\n');

      for (const [tier, data] of Object.entries(stats)) {
        const config = MEMORY_TIERS[tier as keyof typeof MEMORY_TIERS];
        console.log(`${config.name}:`);
        console.log(`  Count: ${data.count}`);
        console.log(`  Avg Importance: ${data.avgImportance.toFixed(3)}`);
        console.log(`  Est. Tokens: ${data.totalTokens} / ${config.maxTokens}`);
        console.log('');
      }

      await instance.db.close();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Journal commands
const journal = program.command('journal').description('Journal management commands');

journal
  .command('list')
  .description('List recent journal entries')
  .option('-t, --type <type>', 'Filter by type')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (options) => {
    try {
      const instance = await load();

      const entries = options.type
        ? await instance.journal.getByType(options.type, parseInt(options.limit, 10))
        : await instance.journal.getRecent(parseInt(options.limit, 10));

      console.log(`\n📓 Journal Entries (${entries.length})\n`);

      for (const entry of entries) {
        const typeEmoji: Record<string, string> = {
          thought: '💭',
          action: '⚡',
          observation: '👁️',
          reflection: '🪞',
          decision: '⚖️',
          error: '❌',
          milestone: '🎯',
        };

        const timestamp = entry.createdAt.toISOString().slice(0, 19).replace('T', ' ');
        console.log(`${typeEmoji[entry.entryType]} [${timestamp}] ${entry.entryType.toUpperCase()}`);
        console.log(`   ${entry.content.slice(0, 150)}${entry.content.length > 150 ? '...' : ''}`);
        console.log('');
      }

      await instance.db.close();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Tools commands
const tools = program.command('tools').description('Tool management commands');

tools
  .command('list')
  .description('List registered tools')
  .action(async () => {
    try {
      const instance = await load();
      const allTools = await instance.tools.listAll();

      console.log(`\n🔧 Registered Tools (${allTools.length})\n`);

      for (const tool of allTools) {
        const status = tool.enabled ? '✓' : '✗';
        console.log(`[${status}] ${tool.name} (priority: ${tool.priority})`);
        console.log(`    ${tool.description}`);
        console.log('');
      }

      await instance.db.close();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Queue commands
const queueCmd = program.command('queue').description('Task queue management commands');

queueCmd
  .command('list')
  .description('Show queued tasks')
  .option('-s, --status <status>', 'Filter by status (pending, running, completed, failed)')
  .option('-l, --limit <number>', 'Limit results', '20')
  .action(async (options) => {
    try {
      const instance = await load();
      const queue = new QueueManager(instance.db);

      const tasks = await queue.list({
        status: options.status,
        limit: parseInt(options.limit, 10),
      });

      console.log(`\n📋 Task Queue (${tasks.length})\n`);

      const statusIcons: Record<string, string> = {
        pending: '○',
        running: '◉',
        completed: '✓',
        failed: '✗',
        cancelled: '⊘',
      };

      for (const task of tasks) {
        const icon = statusIcons[task.status] ?? '•';
        console.log(`${icon} [${task.status}] ${task.type} (priority: ${task.priority})`);
        if (task.error) {
          console.log(`    Error: ${task.error}`);
        }
        console.log('');
      }

      await instance.db.close();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

queueCmd
  .command('add <type>')
  .description('Add a task to the queue')
  .option('-p, --priority <number>', 'Task priority', '0')
  .option('-d, --data <json>', 'JSON payload')
  .action(async (type, options) => {
    try {
      const instance = await load();
      const queue = new QueueManager(instance.db);

      const task = await queue.add({
        type,
        priority: parseInt(options.priority, 10),
        payload: options.data ? JSON.parse(options.data) : undefined,
      });

      console.log(`✓ Task added: ${task.id}`);
      await instance.db.close();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

queueCmd
  .command('cancel <id>')
  .description('Cancel a pending task')
  .action(async (id) => {
    try {
      const instance = await load();
      const queue = new QueueManager(instance.db);

      const cancelled = await queue.cancel(id);
      if (cancelled) {
        console.log(`✓ Task cancelled: ${id}`);
      } else {
        console.log(`Task ${id} is not pending or not found`);
      }

      await instance.db.close();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Watch commands
const watch = program.command('watch').description('File watcher management commands');

watch
  .command('add <pattern>')
  .description('Add a file watcher')
  .option('-a, --action <action>', 'Action type (run, memory, queue)', 'memory')
  .option('-d, --debounce <ms>', 'Debounce interval in ms', '500')
  .action(async (pattern, options) => {
    try {
      const instance = await load();
      const watcher = new FileWatcher(instance.db);

      const result = await watcher.add({
        pattern,
        action: options.action,
        debounceMs: parseInt(options.debounce, 10),
      });

      console.log(`✓ Watcher added: ${result.id}`);
      console.log(`  Pattern: ${result.pattern}`);
      console.log(`  Action: ${result.action}`);

      await instance.db.close();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

watch
  .command('list')
  .description('List active watchers')
  .action(async () => {
    try {
      const instance = await load();
      const watcher = new FileWatcher(instance.db);

      const watchers = await watcher.list();

      console.log(`\n👁️ File Watchers (${watchers.length})\n`);

      for (const w of watchers) {
        const status = w.enabled ? '✓' : '✗';
        console.log(`[${status}] ${w.id.slice(0, 8)}... - ${w.pattern}`);
        console.log(`    Action: ${w.action}`);
        console.log(`    Debounce: ${w.debounceMs}ms`);
        console.log('');
      }

      await instance.db.close();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

watch
  .command('remove <id>')
  .description('Remove a watcher')
  .action(async (id) => {
    try {
      const instance = await load();
      const watcher = new FileWatcher(instance.db);

      const removed = await watcher.remove(id);
      if (removed) {
        console.log(`✓ Watcher removed: ${id}`);
      } else {
        console.log(`Watcher ${id} not found`);
      }

      await instance.db.close();
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Constitution commands
program
  .command('constitution')
  .description('View the agent constitution')
  .action(async () => {
    try {
      const constitution = await loadConstitution();
      console.log('\n' + constitution);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Config commands
program
  .command('config')
  .description('View or update configuration')
  .option('-s, --set <key=value>', 'Set a config value')
  .action(async (options) => {
    try {
      if (options.set) {
        const [key, value] = options.set.split('=');
        let parsedValue: unknown = value;

        // Parse booleans and numbers
        if (value === 'true') parsedValue = true;
        else if (value === 'false') parsedValue = false;
        else if (!isNaN(Number(value))) parsedValue = Number(value);

        const config = await updateConfig({ [key]: parsedValue });
        console.log(`✓ Updated ${key} = ${parsedValue}`);
        console.log('\nCurrent config:');
        console.log(JSON.stringify(config, null, 2));
      } else {
        const status = await getStatus();
        console.log('\nCurrent config:');
        console.log(JSON.stringify(status.config, null, 2));
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Helper function
function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// Parse and execute
program.parse();
