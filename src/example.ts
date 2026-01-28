/**
 * Kronk Example Usage
 * 
 * This file demonstrates how to use the Kronk framework
 * to build an autonomous agent.
 */

import {
  init,
  load,
  Agent,
  OpenAIEmbedder,
  MockEmbedder,
  type LLMProvider,
  type Message,
  type Tool,
} from './index.js';

/**
 * Example LLM provider using Anthropic Claude
 * You would implement this with your preferred LLM SDK
 */
class ClaudeLLMProvider implements LLMProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async complete(
    messages: Message[],
    options?: { temperature?: number; maxTokens?: number; tools?: Tool[] }
  ) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature ?? 0.7,
        system: messages.find(m => m.role === 'system')?.content ?? '',
        messages: messages
          .filter(m => m.role !== 'system')
          .map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
          })),
        // Convert tools to Anthropic format if needed
        tools: options?.tools?.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.schema,
        })),
      }),
    });

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
      usage: { input_tokens: number; output_tokens: number };
    };

    // Extract text and tool calls
    let content = '';
    const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

    for (const block of data.content) {
      if (block.type === 'text') {
        content += block.text ?? '';
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          name: block.name!,
          arguments: block.input!,
        });
      }
    }

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed: data.usage.input_tokens + data.usage.output_tokens,
    };
  }
}

/**
 * Main example function
 */
async function main() {
  console.log('🦾 Kronk Framework Example\n');

  // Check for API keys
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Initialize or load the agent
  console.log('Initializing agent...');
  const instance = await init(undefined, {
    config: {
      name: 'example-agent',
      debug: true,
    },
    force: true, // Reinitialize for demo
  });

  // Create providers
  const embedder = openaiKey
    ? new OpenAIEmbedder({ apiKey: openaiKey })
    : new MockEmbedder(); // Fallback for demo

  if (!anthropicKey) {
    console.log('\n⚠️  No ANTHROPIC_API_KEY found. Showing manual usage instead.\n');
    await manualUsageDemo(instance);
    return;
  }

  const llm = new ClaudeLLMProvider(anthropicKey);

  // Create the agent
  const agent = new Agent(instance, {
    llm,
    embedder,
    maxIterations: 5,
    autoJournal: true,
  });

  // Initialize agent (registers core tools)
  await agent.initialize();

  // Register a custom tool
  await agent.registerTool(
    'get_weather',
    'Get current weather for a location',
    {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City name or coordinates',
        },
      },
      required: ['location'],
    },
    async (params) => {
      // Mock implementation
      return {
        location: params.location,
        temperature: 22,
        conditions: 'Partly cloudy',
        humidity: 65,
      };
    }
  );

  // Add some initial memories
  await agent.remember('User is a software engineer interested in AI', {
    tier: 'system2',
    tags: ['user-profile'],
    importance: 0.9,
  });

  await agent.remember('Currently working on a project management app', {
    tier: 'working',
    tags: ['current-project'],
    importance: 0.8,
  });

  // Run the agent
  console.log('\nRunning agent...\n');
  const result = await agent.run(
    "What's the weather like in San Francisco? Also, do you remember what kind of project I'm working on?"
  );

  console.log('Response:', result.response);
  console.log('\nStats:');
  console.log(`  Iterations: ${result.iterations}`);
  console.log(`  Tokens used: ${result.tokensUsed}`);
  console.log(`  Journal entries: ${result.journalEntries.length}`);
  console.log(`  Memories created: ${result.memoriesCreated.length}`);

  // Trigger reflection
  console.log('\nTriggering reflection...');
  const reflection = await agent.reflect();
  console.log('Reflection:', reflection.content);

  // Get overall stats
  const stats = await agent.getStats();
  console.log('\nAgent Stats:', JSON.stringify(stats, null, 2));

  // Cleanup
  await agent.shutdown();
  console.log('\n✓ Agent shutdown complete');
}

/**
 * Demo without LLM - showing direct component usage
 */
async function manualUsageDemo(instance: Awaited<ReturnType<typeof init>>) {
  console.log('📚 Manual Component Usage Demo\n');

  // Memory operations
  console.log('--- Memory ---');

  const mem1 = await instance.memory.store({
    tier: 'system2',
    content: 'Core principle: Always be helpful and honest',
    importance: 1.0,
    source: 'user',
    tags: ['principle', 'core'],
  });
  console.log('Stored system2 memory:', mem1.id);

  const mem2 = await instance.memory.store({
    tier: 'working',
    content: 'Currently helping user build a Kronk agent',
    importance: 0.8,
    source: 'inference',
    tags: ['task'],
  });
  console.log('Stored working memory:', mem2.id);

  const mem3 = await instance.memory.store({
    tier: 'system1',
    content: 'User just asked about memory systems',
    importance: 0.5,
    source: 'agent',
    tags: ['recent'],
  });
  console.log('Stored system1 memory:', mem3.id);

  // Build context
  const context = await instance.memory.buildContextWindow();
  console.log('\nContext window:');
  console.log(`  System2: ${context.system2.length} memories`);
  console.log(`  Working: ${context.working.length} memories`);
  console.log(`  System1: ${context.system1.length} memories`);
  console.log(`  Total tokens: ~${context.totalTokens}`);

  // Memory stats
  const memStats = await instance.memory.getStats();
  console.log('\nMemory stats:', memStats);

  // Journal operations
  console.log('\n--- Journal ---');

  const session = await instance.journal.startSession({
    name: 'Demo Session',
    goal: 'Demonstrate Kronk capabilities',
  });
  console.log('Started session:', session);

  await instance.journal.thought('Beginning demonstration of the framework');
  await instance.journal.observation('User is running the example script');
  await instance.journal.decision('Showing manual component usage', 0.95);
  await instance.journal.milestone('Successfully demonstrated memory and journal');

  const entries = await instance.journal.getRecent(10);
  console.log(`\nRecent journal entries: ${entries.length}`);
  for (const entry of entries) {
    console.log(`  [${entry.entryType}] ${entry.content.slice(0, 50)}...`);
  }

  // Tool registration
  console.log('\n--- Tools ---');

  await instance.tools.register({
    name: 'calculator',
    description: 'Perform basic arithmetic',
    schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['add', 'subtract', 'multiply', 'divide'],
        },
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['operation', 'a', 'b'],
    },
    handler: 'runtime:calculator',
  });

  instance.tools.registerHandler('calculator', async (params) => {
    const { operation, a, b } = params as { operation: string; a: number; b: number };
    switch (operation) {
      case 'add':
        return { result: a + b };
      case 'subtract':
        return { result: a - b };
      case 'multiply':
        return { result: a * b };
      case 'divide':
        return { result: a / b };
      default:
        throw new Error('Unknown operation');
    }
  });

  const tools = await instance.tools.listEnabled();
  console.log(`Registered tools: ${tools.length}`);

  // Invoke tool
  const calcResult = await instance.tools.invoke('calculator', {
    operation: 'multiply',
    a: 7,
    b: 6,
  });
  console.log('Calculator result:', calcResult);

  // End session
  await instance.journal.endSession('completed');

  // Close DB
  await instance.db.close();

  console.log('\n✓ Demo complete!');
  console.log('\nTo run with full agent capabilities, set these environment variables:');
  console.log('  ANTHROPIC_API_KEY - for Claude LLM');
  console.log('  OPENAI_API_KEY    - for embeddings (optional, uses mock otherwise)');
}

// Run
main().catch(console.error);
