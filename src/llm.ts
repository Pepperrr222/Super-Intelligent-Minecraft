import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type LlmRequest = {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
};

export interface LlmClient {
  complete(request: LlmRequest): Promise<string>;
}

export type OpenAiCompatibleOptions = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
};

/** Minimal OpenAI-compatible chat client. It never logs the API key. */
export class OpenAiCompatibleClient implements LlmClient {
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetcher = options.fetcher ?? fetch;
  }

  async complete(request: LlmRequest): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(
        `${this.options.baseUrl.replace(/\/+$/u, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify({
            model: this.options.model,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
            temperature: request.temperature ?? 0.2,
            max_tokens: request.maxTokens ?? 800,
            stream: false,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(`LLM_HTTP_${response.status}`);
      const data = await response.json() as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('LLM_EMPTY_RESPONSE');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

export type LlmProvider = 'deepseek' | 'siliconflow';

type ProviderDefaults = {
  baseUrl: string;
  model: string;
  secret: string;
};

const PROVIDERS: Record<LlmProvider, ProviderDefaults> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    secret: 'deepseek.key',
  },
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    secret: 'siliconflow.key',
  },
};

export type LlmSetup = {
  client: LlmClient;
  provider: LlmProvider;
  model: string;
  baseUrl: string;
};

function readSecret(name: string): string | undefined {
  const envKey = process.env[`${name.toUpperCase()}_API_KEY`]?.trim();
  if (envKey) return envKey;
  const shared = process.env.LLM_API_KEY?.trim();
  if (shared) return shared;
  try {
    return readFileSync(resolve(process.cwd(), '.secrets', PROVIDERS[name as LlmProvider].secret), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load an OpenAI-compatible provider from environment or .secrets/.
 * Provider order: LLM_PROVIDER, then deepseek, then siliconflow.
 * The key is read but never returned or printed.
 */
export function loadLlmFromSecrets(): LlmSetup | undefined {
  const requested = process.env.LLM_PROVIDER?.toLowerCase();
  const candidates: LlmProvider[] = requested
    ? (requested === 'deepseek' || requested === 'siliconflow' ? [requested] : [])
    : ['deepseek', 'siliconflow'];

  for (const provider of candidates) {
    const apiKey = readSecret(provider);
    if (!apiKey) continue;
    const defaults = PROVIDERS[provider];
    const baseUrl = process.env.LLM_BASE_URL?.trim() || defaults.baseUrl;
    const model = process.env.LLM_MODEL?.trim() || defaults.model;
    const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 15_000);
    return {
      client: new OpenAiCompatibleClient({
        apiKey,
        baseUrl,
        model,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 15_000,
      }),
      provider,
      model,
      baseUrl,
    };
  }
  return undefined;
}
