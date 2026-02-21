/**
 * Interactive Init Wizard
 *
 * Guided setup experience for `kronk init`.
 * Uses @inquirer/prompts for TTY-based interactive prompts.
 *
 * Returns a WizardResult — does NOT call init() itself.
 */

export interface WizardResult {
  name: string;
  provider: string;
  model: string;
  useVectorSearch: boolean;
  force: boolean;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export async function validateOpenAIKey(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 401) {
      return { valid: false, error: 'Invalid API key (401 Unauthorized)' };
    }
    if (!res.ok) {
      return { valid: false, error: `API responded with status ${res.status}` };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Connection failed: ${(err as Error).message}` };
  }
}

export async function validateAnthropicKey(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    // 401 = bad key; anything else (including 400, 429) means the key is likely valid
    if (res.status === 401) {
      return { valid: false, error: 'Invalid API key (401 Unauthorized)' };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, error: `Connection failed: ${(err as Error).message}` };
  }
}

export async function checkOllamaConnection(
  host: string = 'http://localhost:11434',
): Promise<{ connected: boolean; models: string[]; error?: string }> {
  try {
    const res = await fetch(`${host}/api/tags`);
    if (!res.ok) {
      return { connected: false, models: [], error: `Status ${res.status}` };
    }
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map((m) => m.name);
    return { connected: true, models };
  } catch (err) {
    return { connected: false, models: [], error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Wizard
// ---------------------------------------------------------------------------

export async function runInitWizard(existingInstall: boolean): Promise<WizardResult> {
  // Dynamic import so @inquirer/prompts is only loaded when wizard runs
  const { input, select, confirm, password } = await import('@inquirer/prompts');

  console.log('');
  console.log('\x1b[35m\x1b[1m  Kronk Agent Setup\x1b[0m');
  console.log('\x1b[2m  Interactive configuration wizard\x1b[0m');
  console.log('');

  // ── Existing install check ──────────────────────────────────────────────
  let force = false;
  if (existingInstall) {
    const reinit = await confirm({
      message: 'An existing .kronk/ installation was found. Reinitialize?',
      default: false,
    });
    if (!reinit) {
      console.log('Exiting. Your existing installation is unchanged.');
      process.exit(0);
    }
    force = true;
  }

  // ── Agent name ──────────────────────────────────────────────────────────
  const name = await input({
    message: 'Agent name:',
    default: 'kronk-agent',
  });

  // ── LLM provider ───────────────────────────────────────────────────────
  const provider = await select({
    message: 'LLM provider:',
    choices: [
      { name: 'Ollama (local, free)', value: 'ollama' },
      { name: 'OpenAI', value: 'openai' },
      { name: 'Anthropic', value: 'anthropic' },
    ],
  });

  // ── Provider defaults ──────────────────────────────────────────────────
  const providerDefaults: Record<string, string> = {
    ollama: 'llama3.2',
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-4-20250514',
  };

  // ── Model ──────────────────────────────────────────────────────────────
  const model = await input({
    message: 'Model:',
    default: providerDefaults[provider] ?? 'llama3.2',
  });

  // ── API key / connection checks ────────────────────────────────────────
  if (provider === 'openai') {
    await handleOpenAIKey(password);
  } else if (provider === 'anthropic') {
    await handleAnthropicKey(password);
  } else if (provider === 'ollama') {
    await handleOllamaCheck();
  }

  // ── Vector search ──────────────────────────────────────────────────────
  const useVectorSearch = await confirm({
    message: 'Enable vector search (requires an embedding model)?',
    default: false,
  });

  // ── Summary ────────────────────────────────────────────────────────────
  console.log('');
  console.log('\x1b[1m  Configuration summary\x1b[0m');
  console.log(`  Name:           ${name}`);
  console.log(`  Provider:       ${provider}`);
  console.log(`  Model:          ${model}`);
  console.log(`  Vector search:  ${useVectorSearch ? 'enabled' : 'disabled'}`);
  if (force) {
    console.log('  Reinitialize:   yes');
  }
  console.log('');

  const proceed = await confirm({
    message: 'Proceed with this configuration?',
    default: true,
  });

  if (!proceed) {
    console.log('Setup cancelled.');
    process.exit(0);
  }

  return { name, provider, model, useVectorSearch, force };
}

// ---------------------------------------------------------------------------
// Provider-specific helpers
// ---------------------------------------------------------------------------

async function handleOpenAIKey(
  password: (opts: { message: string; mask?: string }) => Promise<string>,
): Promise<void> {
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) {
    console.log('  Found OPENAI_API_KEY in environment. Validating...');
    const result = await validateOpenAIKey(envKey);
    if (result.valid) {
      console.log('\x1b[32m  ✓ API key is valid\x1b[0m');
    } else {
      console.log(`\x1b[33m  ⚠ Validation failed: ${result.error}\x1b[0m`);
    }
    return;
  }

  console.log('  OPENAI_API_KEY not found in environment.');
  const key = await password({
    message: 'Enter your OpenAI API key (or press Enter to skip):',
    mask: '*',
  });

  if (key) {
    console.log('  Validating...');
    const result = await validateOpenAIKey(key);
    if (result.valid) {
      console.log('\x1b[32m  ✓ API key is valid\x1b[0m');
      process.env.OPENAI_API_KEY = key;
    } else {
      console.log(`\x1b[33m  ⚠ Validation failed: ${result.error}\x1b[0m`);
      console.log('  Setting key anyway — you can fix it later via env vars.');
      process.env.OPENAI_API_KEY = key;
    }
  } else {
    console.log('\x1b[33m  ⚠ No API key set. Set OPENAI_API_KEY before running the agent.\x1b[0m');
  }
}

async function handleAnthropicKey(
  password: (opts: { message: string; mask?: string }) => Promise<string>,
): Promise<void> {
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) {
    console.log('  Found ANTHROPIC_API_KEY in environment. Validating...');
    const result = await validateAnthropicKey(envKey);
    if (result.valid) {
      console.log('\x1b[32m  ✓ API key is valid\x1b[0m');
    } else {
      console.log(`\x1b[33m  ⚠ Validation failed: ${result.error}\x1b[0m`);
    }
    return;
  }

  console.log('  ANTHROPIC_API_KEY not found in environment.');
  const key = await password({
    message: 'Enter your Anthropic API key (or press Enter to skip):',
    mask: '*',
  });

  if (key) {
    console.log('  Validating...');
    const result = await validateAnthropicKey(key);
    if (result.valid) {
      console.log('\x1b[32m  ✓ API key is valid\x1b[0m');
      process.env.ANTHROPIC_API_KEY = key;
    } else {
      console.log(`\x1b[33m  ⚠ Validation failed: ${result.error}\x1b[0m`);
      console.log('  Setting key anyway — you can fix it later via env vars.');
      process.env.ANTHROPIC_API_KEY = key;
    }
  } else {
    console.log('\x1b[33m  ⚠ No API key set. Set ANTHROPIC_API_KEY before running the agent.\x1b[0m');
  }
}

async function handleOllamaCheck(): Promise<void> {
  const host = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  console.log(`  Checking Ollama at ${host}...`);
  const result = await checkOllamaConnection(host);
  if (result.connected) {
    console.log('\x1b[32m  ✓ Ollama is running\x1b[0m');
    if (result.models.length > 0) {
      console.log(`  Available models: ${result.models.join(', ')}`);
    } else {
      console.log('\x1b[33m  ⚠ No models found. Pull one with: ollama pull llama3.2\x1b[0m');
    }
  } else {
    console.log(`\x1b[33m  ⚠ Could not connect to Ollama: ${result.error}\x1b[0m`);
    console.log('  Make sure Ollama is running: ollama serve');
  }
}
