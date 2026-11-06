import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Explicit environment configuration takes precedence over project-local approval. */
export function loadPromptApproval(): string | undefined {
  if (process.env.SIM_APPROVED_PROMPTS !== undefined) return process.env.SIM_APPROVED_PROMPTS;
  try {
    const value: unknown = JSON.parse(readFileSync(resolve('.prompt-approval.local.json'), 'utf8'));
    const hash = (value as { hash?: unknown } | null)?.hash;
    return typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) ? hash : undefined;
  } catch { return undefined; } // Missing/invalid approval never enables a model request.
}
