import type { PlayerMessage, SessionSnapshot } from './interaction.js';
import type { Task, TaskSnapshot } from './task.js';
import type { ModelQuery, BasicOperation } from './schema.js';
import type { OperationCard } from './basic-operations.js';

/**
 * Versioned contract between the program and the decision model. These types
 * are serialised into the model request, so every field must be safe to send:
 * no slots, NBT, fingerprints, entity UUIDs or raw snapshots.
 */
export type BrainContextV1 = {
  schema: 'sim.brain.v1';
  trigger: DecisionTrigger;
  now: number;
  player: { name: string; isOwner: boolean };
  message?: { text: string; channel: 'chat' | 'whisper' | 'console' };
  session: {
    recent: Array<{ role: 'player' | 'agent'; text: string; ageMs: number }>;
    pending:
      | null
      | { kind: 'confirm'; prompt: string; task: { goal: string | null; steps: number } }
      | { kind: 'clarify'; question: string };
    lastGoal: string | null;
  };
  currentTask: null | {
    id: string;
    goal: string | null;
    state: 'queued' | 'running' | 'paused' | 'cancelling';
    currentStep: number;
    totalSteps: number;
    attempts: number;
    lastStatus: string | null;
    lastErrorCode: string | null;
  };
  lastRun: RunFeedbackV1 | null;
  /** null means observation is unavailable this turn; the model must not guess. */
  observation: ObservationSummaryV1 | null;
  availableSkills: SkillCardV1[];
  availableOperations?: BasicOperation['type'][];
  operationCatalog?: OperationCard[];
  limits: {
    maxPlanSteps: number;
    maxPlanSeconds: number;
    maxReplyChars: number;
  };
  /** Present only when low-priority fields had to be trimmed to fit the byte budget. */
  truncated?: boolean;
};

export type ObservationSummaryV1 = {
  observedAt: number;
  version: string;
  dimension: string;
  gameMode: string;
  self: {
    position: { x: number; y: number; z: number } | null;
    health: number | null;
    food: number | null;
  };
  perception: {
    radius: number;
    scope: 'loaded_client_chunks';
    completeWorldSearch: false;
  };
  inventory: Array<{ name: string; count: number }>;
  inventoryTruncated: boolean;
  equipped: Array<{
    slot: 'mainhand' | 'offhand' | 'head' | 'chest' | 'legs' | 'feet';
    name: string;
  }>;
  entities: Array<{
    kind: 'player' | 'item' | 'mob' | 'other';
    name: string;
    /** null when the bot cannot observe its own position. */
    distance: number | null;
  }>;
  entitiesTruncated: boolean;
};

export type SkillCardV1 = {
  id: string;
  description: string;
  params: Record<string, unknown>;
  requiresConfirmation: boolean;
  idempotent: boolean;
  available: boolean;
  unavailableReason?: string;
  notes?: string[];
};

export type RunFeedbackV1 = {
  taskId: string;
  goal: string | null;
  source: 'skill' | 'plan';
  outcome: 'completed' | 'failed' | 'blocked' | 'partial' | 'cancelled' | 'timeout';
  verified: boolean;
  finishedAt: number;
  elapsedMs: number;
  steps: Array<{
    stepId: string;
    skill: string | null;
    status: 'ok' | 'blocked' | 'busy' | 'cancelled' | 'timeout' | 'error' | 'partial' | 'not_run';
    evidence: 'request_sent' | 'client_observed' | 'api_complete' | 'step_verified' | null;
    error: { code: string; message: string } | null;
    output: Record<string, unknown> | null;
  }>;
  verifiedChanges: {
    inventory: Array<{ item: string; delta: number }>;
    containers: Array<{ position: { x: number; y: number; z: number }; item: string; delta: number }>;
    position: {
      before: { x: number; y: number; z: number } | null;
      after: { x: number; y: number; z: number } | null;
      target?: { x: number; y: number; z: number };
      range?: number;
    } | null;
  };
  sideEffects: string[];
  retryable: boolean;
  repeatedFailure: boolean;
};

export type DecisionTrigger = 'player_message' | 'run_finished';

/** Raw model decision after JSON parsing; never executed without validation. */
export type BrainDecision =
  | { kind: 'query'; query: ModelQuery }
  | { kind: 'operations'; goal: string; operations: BasicOperation[]; replaceCurrent?: boolean }
  | { kind: 'reply'; text: string }
  | { kind: 'clarify'; question: string }
  | { kind: 'skill'; skill: string; params: Record<string, unknown>; replaceCurrent?: boolean }
  | {
      kind: 'plan';
      goal: string;
      steps: Array<{ skill: string; params: Record<string, unknown> }>;
      budget: { maxSteps: number; maxSeconds: number };
      replaceCurrent?: boolean;
    }
  | { kind: 'control'; action: 'cancel' }
  | { kind: 'confirm' }
  | { kind: 'reject' };

export type DecisionRequest = {
  trigger: DecisionTrigger;
  player: { name: string; isOwner: boolean };
  session: SessionSnapshot;
  message?: PlayerMessage;
  currentTask?: TaskSnapshot;
  /** The last verified run; present for both feedback turns and later player turns. */
  lastRun?: RunFeedbackV1;
  /** skill+params keys that already failed twice; the validator refuses them. */
  blockedCalls?: string[];
  signal?: AbortSignal;
};

/** The validated result of one decision. Only the interaction layer may submit it. */
export type DecisionOutcome =
  | { kind: 'reply'; text: string; clearPending?: boolean }
  | { kind: 'clarify'; question: string; clearPending?: boolean }
  | { kind: 'control'; action: 'cancel'; taskId: string; clearPending?: boolean }
  | {
      kind: 'task';
      task: Task;
      ack?: string;
      confirmation?: string;
      /** The program stops the active task before submitting this one. */
      replaceCurrent?: boolean;
      clearPending?: boolean;
    };

export interface DecisionPort {
  decide(input: DecisionRequest): Promise<DecisionOutcome>;
}
