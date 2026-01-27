#!/usr/bin/env node
/**
 * Kronk CLI
 * 
 * Command-line interface for managing Kronk agents.
 */

import { Command } from 'commander';
import { init, load, getStatus, updateConfig, loadConstitution, updateConstitution } from './init/index.js';
import { MEMORY_TIERS } from './db/schema.js';

const program = new Command();

program
  .name('kronk')
  .description('Agentic AI framework with tiered memory and vector search')
  .version('0.1.0');

// Initialize command
program
  .command('init')
  .description('Initialize a new Kronk agent in the current directory')
  .option('-n, --name <name>', 'Agent name', 'kronk-agent')
  .option('-m, --model <model>', 'LLM model to use', 'claude-sonnet-4-20250514')
  .option('-f, --force', 'Overwrite existing installation')
  .action(async (options) => {
    try {
      await init(undefined, {
        config: {
          name: options.name,
          model: options.model,
        },
        force: options.force,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Show agent status and statistics')
  .action(async () => {
    try {
      const status = await getStatus();
      
      console.log('\n🤖 Kronk Agent Status\n');
      console.log(`Path: ${status.path}`);
      console.log(`Initialized: ${status.initialized ? '✓' : '✗'}`);
      
      if (status.config) {
        console.log(`\nConfiguration:`);
        console.log(`  Name: ${status.config.name}`);
        console.log(`  Model: ${status.config.model}`);
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

// Parse and execute
program.parse();
