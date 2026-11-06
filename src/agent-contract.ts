import { z } from 'zod';
import { basicOperationSchema, querySchema } from './schema.js';
import { resourceMemorySchema } from './resource-memory.js';
import { stagePlanSchema,stageStateSchema } from './stage-plan.js';

const text = z.string().trim().min(1).max(2000);
const list = z.array(text).max(32);
export const criteriaSchema = z.array(z.object({ id: text, text }).strict()).min(1).max(32)
  .refine(items => new Set(items.map(i => i.id)).size === items.length, 'criterion ids must be unique');
export const assessmentSchema = z.object({
  verdicts: z.array(z.object({ criterionId: text, verdict: z.enum(['met', 'not_met', 'unknown']),
    evidenceIds: z.array(text).max(32), explanation: text }).strict()).min(1).max(32),
  omittedRequirements: list,
  summary: text,
}).strict();
export const routeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('goal'), mode: z.enum(['new', 'amend', 'replace']), objective: text,
    criteria: criteriaSchema, assumptions: list }).strict(),
  z.object({ kind: z.literal('respond'), text }).strict(),
  z.object({ kind: z.literal('control'), action: z.enum(['cancel', 'pause', 'resume']) }).strict(),
  z.object({ kind: z.literal('ask'), question: text, reason: text }).strict(),
]);
export const directorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reconcile'), evidenceIds: z.array(text).min(1).max(32), explanation: text }).strict(),
  z.object({ kind: z.literal('advance'), next: text, constraints: list, expectedEvidence: list }).strict(),
  z.object({ kind: z.literal('assess') }).strict(),
  z.object({ kind: z.literal('ask'), question: text, reason: text }).strict(),
  z.object({ kind: z.literal('wait'), reason: text, milliseconds: z.number().int().min(100).max(60_000) }).strict(),
  z.object({ kind: z.literal('blocked'), reason: text }).strict(),
]);
export const executionSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('plan'),plan:stagePlanSchema}).strict(),
  z.object({ kind: z.literal('read_evidence'), ids: z.array(text).min(1).max(8) }).strict(),
  z.object({ kind: z.literal('query'), query: querySchema }).strict(),
  z.object({ kind: z.literal('propose'), purpose: text,
    continueStage:z.boolean().optional(),
    // Accepted only for old clients; no model review is performed regardless of this value.
    requestReview:z.boolean().optional(),
    operations: z.array(basicOperationSchema).min(1).max(4) }).strict(),
  z.object({ kind:z.literal('stage_done'), summary:text }).strict(),
  z.object({ kind: z.literal('cannot_execute'), reason: text }).strict(),
]);
export type Assessment = z.infer<typeof assessmentSchema>;
export type Direction = Extract<z.infer<typeof directorSchema>, { kind: 'advance' }>;

/** One decision protocol: no natural-language handoff to a second planning model. */
export const agentDecisionSchema = z.discriminatedUnion('kind', [
  ...routeSchema.options,
  executionSchema.options[0], executionSchema.options[1], executionSchema.options[2], executionSchema.options[3],
  directorSchema.options[0], directorSchema.options[4], directorSchema.options[5],
  z.object({kind:z.literal('finish'),assessment:assessmentSchema}).strict(),
]);
export type AgentDecision = z.infer<typeof agentDecisionSchema>;

export const goalSchema = z.object({
  id: text, owner: text, revision: z.number().int().min(1), originalRequest: text,
  messages: z.array(z.object({ id: text, text, at: z.number() })).max(128),
  objective: text, criteria: criteriaSchema, assumptions: list, remaining: list,
  status: z.enum(['active', 'waiting_world', 'waiting_player', 'paused', 'reconciling', 'completed', 'failed', 'cancelled']),
  createdAt: z.number(), deadline: z.number(), wakeAt: z.number().optional(),
  budget: z.object({ calls: z.number().int().nonnegative(), operations: z.number().int().nonnegative(), activeMs: z.number().nonnegative() }),
  noProgress: z.number().int().nonnegative(), lastState: z.string(),
  reconciliationFailures: z.number().int().nonnegative().optional(),
  pendingBatch: z.object({ id: text, revision: z.number().int(), operations: z.array(basicOperationSchema) }).optional(),
  assessment: assessmentSchema.optional(),
  stage:stageStateSchema.optional(),
}).strict();
export type AgentGoal = z.infer<typeof goalSchema>;
export const eventSchema = z.object({ id: text, at: z.number(), goalId: text.nullable(), revision: z.number().int(),
  kind: z.enum(['message', 'observation', 'query', 'proposal', 'review', 'submitted', 'batch', 'assessment', 'control', 'error', 'reply', 'memory']),
  data: z.unknown(),
}).strict();
export type AgentEvent = z.infer<typeof eventSchema>;
export const agentStateSchema = z.object({ version: z.literal(2), sequence: z.number().int().nonnegative(),
  resources:resourceMemorySchema.optional(),
  craftingRequests:z.array(z.object({goalId:text,query:querySchema})).max(8).optional(),
  goal: goalSchema.nullable(), events: z.array(eventSchema).max(2048),
  recent: z.array(z.object({ player: text, text, at: z.number() })).max(16),
  pendingRequest: z.object({ player: text, id: text, text, at: z.number() }).optional(),
}).strict();
export type AgentState = z.infer<typeof agentStateSchema>;
export const emptyAgentState = (): AgentState => ({ version: 2, sequence: 0, goal: null, events: [], recent: [] });
export const isOpenGoal = (goal: AgentGoal | null): goal is AgentGoal => !!goal && !['completed', 'failed', 'cancelled'].includes(goal.status);

/** Remove opaque item internals, preserve complete evidence structure. No diagnostic truncation. */
export function publicEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicEvidence);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(nbt|components|removedComponents|fingerprint|uuid|metadata|apiKey|authorization|password|secret|token)$/i.test(key))
    .map(([key, entry]) => [key, publicEvidence(entry)]));
  return typeof value === 'bigint' ? String(value) : value;
}
