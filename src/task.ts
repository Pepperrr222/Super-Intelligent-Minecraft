import type { Action, ActionResult, Condition } from './schema.js';

export type TaskState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export type EvidenceLevel =
  | 'request_sent'
  | 'client_observed'
  | 'api_complete'
  | 'step_verified';

export type RetryPolicy = {
  /** Total attempts, including the first one. */
  maxAttempts: number;
  /** Failure statuses that are eligible for retry. Defaults to error and timeout. */
  retryOn?: Array<'error' | 'timeout'>;
};

export type TaskStep = {
  id: string;
  /** One step is one skill/action sequence. The controller runs these in order. */
  actions: Action[];
  preconditions?: Condition[];
  postconditions?: Condition[];
  /** Applied to each underlying action. */
  timeoutMs?: number;
  /** Only idempotent steps may be retried automatically. */
  idempotent?: boolean;
  retry?: RetryPolicy;
};

export type Task = {
  id: string;
  goal?: string;
  /** Larger numbers are dispatched first. */
  priority?: number;
  /** Epoch milliseconds. */
  deadline?: number;
  dependsOn?: string[];
  steps: TaskStep[];
  metadata?: Record<string, unknown>;
};

export type TaskRecord = {
  task: Task;
  planRevision: number;
  state: TaskState;
  currentStep: number;
  /** Failed attempts for the current step. Reset on success. */
  attempts: number;
  submittedAt: number;
  lastResult?: ControllerResult;
};

export type TaskSnapshot = {
  id: string;
  state: TaskState;
  currentStep: number;
  totalSteps: number;
  attempts: number;
  priority: number;
  deadline?: number;
  dependsOn: string[];
  submittedAt: number;
  lastResult?: ControllerResult;
};

export type ControllerCommand = {
  taskId: string;
  planRevision: number;
  step: TaskStep;
  deadline?: number;
  signal?: AbortSignal;
};

export type ControllerStatus =
  | 'ok'
  | 'blocked'
  | 'busy'
  | 'cancelled'
  | 'timeout'
  | 'error'
  | 'partial';

export type ControllerResult = {
  taskId: string;
  planRevision: number;
  stepId: string;
  status: ControllerStatus;
  evidence?: EvidenceLevel;
  data?: unknown;
  /** Every action attempt, including failed or cancelled ones. */
  partialEffects: ActionResult[];
  error?: { code: string; message: string };
  leaseState: 'free' | 'held';
};

export type QueryOutcome = {
  status: string;
  data?: unknown;
  error?: unknown;
};

/** The small surface the controller needs from MinecraftActions. */
export interface ActionPort {
  execute(action: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<ActionResult>;
  query(input: unknown): QueryOutcome;
  stop(reason?: string): void;
  readonly busy: boolean;
}

/** The small surface the scheduler needs from the controller. */
export interface ControllerPort {
  execute(command: ControllerCommand): Promise<ControllerResult>;
  stop(reason?: string): void;
  readonly busy: boolean;
}

export interface TaskLedger {
  load(): TaskRecord[];
  save(record: TaskRecord): void;
  remove(id: string): void;
}
