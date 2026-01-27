/**
 * Kronk Embedding Providers
 * 
 * Implementations for generating vector embeddings from text.
 */

import type { EmbeddingProvider } from '../memory/manager.js';
import { VECTOR_DIMENSIONS } from '../db/schema.js';

/**
 * OpenAI-compatible embedding provider
 */
export class OpenAIEmbedder implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(options: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'text-embedding-3-small';
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
        dimensions: VECTOR_DIMENSIONS,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Embedding API error: ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        dimensions: VECTOR_DIMENSIONS,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Embedding API error: ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to maintain order
    return data.data
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
  }
}

/**
 * Anthropic Voyage-compatible embedding provider
 */
export class VoyageEmbedder implements EmbeddingProvider {
  private apiKey: string;
  private model: string;

  constructor(options: {
    apiKey: string;
    model?: string;
  }) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'voyage-2';
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Voyage API error: ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Voyage API error: ${error}`);
    }

    const data = await response.json() as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data.map(d => d.embedding);
  }
}

/**
 * Local/Ollama embedding provider
 */
export class OllamaEmbedder implements EmbeddingProvider {
  private model: string;
  private baseUrl: string;

  constructor(options: {
    model?: string;
    baseUrl?: string;
  } = {}) {
    this.model = options.model ?? 'nomic-embed-text';
    this.baseUrl = options.baseUrl ?? 'http://localhost:11434';
  }

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${error}`);
    }

    const data = await response.json() as { embedding: number[] };
    return data.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama doesn't support batch, so we do sequential
    const embeddings: number[][] = [];
    for (const text of texts) {
      const embedding = await this.embed(text);
      embeddings.push(embedding);
    }
    return embeddings;
  }
}

/**
 * Mock embedder for testing (generates random vectors)
 */
export class MockEmbedder implements EmbeddingProvider {
  private dimensions: number;
  private cache: Map<string, number[]> = new Map();

  constructor(dimensions = VECTOR_DIMENSIONS) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    // Use cache for consistent results
    if (this.cache.has(text)) {
      return this.cache.get(text)!;
    }

    // Generate deterministic pseudo-random vector from text hash
    const embedding = this.generateFromHash(text);
    this.cache.set(text, embedding);
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }

  private generateFromHash(text: string): number[] {
    // Simple hash function for deterministic results
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }

    const embedding: number[] = [];
    for (let i = 0; i < this.dimensions; i++) {
      // Use hash to seed pseudo-random values
      hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
      hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
      hash ^= hash >>> 16;
      // Normalize to [-1, 1]
      embedding.push((hash % 1000) / 500 - 1);
    }

    // Normalize vector
    const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    return embedding.map(v => v / magnitude);
  }
}
