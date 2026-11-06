import { createHash } from 'node:crypto';
import { z } from 'zod';
import { boundedComplete, parseJsonObject } from './brain.js';
import { packAgentContext } from './agent-context.js';
import { inputJsonSchema } from './schema.js';
import type { LlmClient, LlmRequest } from './llm.js';
import { agentDecisionSchema } from './agent-contract.js';
import { AGENT_PROMPT_VERSION, AGENT_DECISION_PROMPT } from './agent-prompts.js';
import { QUERY_CONTRACTS } from './tool-contracts.js';

/** One registry binds each cognitive responsibility to its prompt and output contract. */
const roles = {
  decision: { prompt: AGENT_DECISION_PROMPT, schema: agentDecisionSchema },
} as const;
export type BrainRole = keyof typeof roles;
export type BrainResult<R extends BrainRole> = z.infer<(typeof roles)[R]['schema']>;

export function brainSystemPrompt(role: BrainRole): string {
  return `SIM_AGENT_ROLE=${role}\n${roles[role].prompt}\n输出 Schema：${JSON.stringify(inputJsonSchema(roles[role].schema))}`;
}

/** Includes the actual schema appended at runtime, not just the prose prompt. */
export function brainPromptManifest() {
  const prompts = Object.keys(roles).map(key => {
    const role = key as BrainRole;
    return { role, system: brainSystemPrompt(role), maxTokens: 5000 };
  });
  const inputContract = {
    normal: 'JSON.stringify(packAgentContext(payload, maxContextBytes))',
    correction: '{"input": <compressed original payload>, "correction": <schema error, max 1800 chars>}',
    fields: ['promptVersion', 'goal', 'pendingRequest', 'recent', 'craftingKnowledge', 'containerMemory',
      'evidence', 'evidenceIndex', 'lastEvents', 'lastTool', 'lastFailure', 'catalog', 'queryContracts', 'freshEvidenceId'],
    triggers: {player_message: ['message'], goal_step: ['goal']},
    queryContracts: QUERY_CONTRACTS,
    temperature: 0.1,
  };
  const body = { version: AGENT_PROMPT_VERSION, prompts, inputContract };
  return { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}

export type AgentBrainOptions = {
  model?: LlmClient;
  /** Backward-compatible configuration alias for model. */
  director?: LlmClient;
  /** Deprecated: the unified loop does not select a separate executor client. */
  executor?: LlmClient;
  callTimeoutMs?: number;
  maxContextBytes?: number;
  /** Production wiring requires review; direct injected test clients need no credentials. */
  requirePromptApproval?: boolean;
  approvedPromptHash?: string;
};

/** Pure model boundary: no scheduler, Bot, storage mutations, or automatic retries. */
export class AgentBrain {
  constructor(private readonly options: AgentBrainOptions = {}) {}

  assertReady(role: BrainRole): void {
    if (this.options.requirePromptApproval && this.options.approvedPromptHash !== brainPromptManifest().hash) {
      throw new Error('BRAIN_PROMPTS_NOT_REVIEWED');
    }
    if (!(this.options.model ?? this.options.director)) {
      throw new Error('V2_MODEL_NOT_CONFIGURED');
    }
  }

  async infer<R extends BrainRole>(role: R, payload: unknown, signal: AbortSignal, correction?: string):
    Promise<{ raw: string; result: { ok: true; value: BrainResult<R> } | { ok: false; correction: string } }> {
    if (signal.aborted) throw new Error('LLM_CANCELLED');
    this.assertReady(role);
    const client = this.options.model ?? this.options.director;
    if (!client) throw new Error('V2_MODEL_NOT_CONFIGURED');
    const limit = this.options.maxContextBytes ?? 64_000;
    const problem = correction?.slice(0, 1800);
    const input = packAgentContext(payload, problem ? limit - Buffer.byteLength(problem) - 64 : limit);
    const request: LlmRequest = {
      system: brainSystemPrompt(role),
      user: JSON.stringify(problem ? { input, correction: problem } : input),
      temperature: 0.1, maxTokens: 5000, signal,
    };
    const raw = await boundedComplete(client, request, this.options.callTimeoutMs ?? 20_000);
    if (signal.aborted) throw new Error('LLM_CANCELLED');
    const parsed = roles[role].schema.safeParse(parseJsonObject(raw));
    return { raw, result: parsed.success
      ? { ok: true, value: parsed.data as BrainResult<R> }
      : { ok: false, correction: parsed.error.message.slice(0, 1800) } };
  }
}
