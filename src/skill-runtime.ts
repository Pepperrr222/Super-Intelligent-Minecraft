import type { Action, ActionResult } from './schema.js';
import type { ActionPort, ControllerProgress, ControllerStatus } from './task.js';

export type SkillStatus = 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'partial';

export type SkillFailure = {
  code: string;
  message: string;
  /** The native action status when the failure came from an action. */
  actionStatus?: ActionResult['status'];
};

export type SkillEvidence =
  | { kind: 'observation'; query: unknown; data?: unknown }
  | { kind: 'action'; action: ActionResult };

/** What a skill implementation returns. The runner adds evidence and progress. */
export type SkillRunResult<O = unknown> = {
  status: SkillStatus;
  output?: O;
  reason?: string;
  error?: SkillFailure;
  partialEffects?: string[];
};

/** The final result handed back to the controller/scheduler. */
export type SkillResult<O = unknown> = SkillRunResult<O> & {
  evidence: SkillEvidence[];
  progress: ControllerProgress[];
  partialEffects: string[];
};

export class SkillRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly actionStatus?: ActionResult['status'],
    readonly actionData?: unknown,
  ) {
    super(message);
    this.name = 'SkillRunError';
  }
}

/**
 * The only capabilities a skill gets. It cannot reach Mineflayer or a second
 * action executor; every query/action still goes through the controller's port.
 */
export type SkillContext = {
  readonly signal: AbortSignal;
  readonly deadline?: number;
  readonly player?: string;
  readonly evidence: SkillEvidence[];
  readonly progress: ControllerProgress[];
  check(): void;
  query<T = unknown>(input: unknown): T;
  execute(action: Action, options?: { timeoutMs?: number }): Promise<ActionResult>;
  report(message: string, data?: unknown): void;
};

export type SkillDefinition<I = unknown, O = unknown> = {
  id: string;
  description: string;
  inputSchema: import('zod').ZodType<I>;
  outputSchema?: import('zod').ZodType<O>;
  supportedVersions: readonly string[];
  risk: 'low' | 'requires_confirmation' | 'destructive';
  requiredCapabilities: readonly string[];
  idempotent: boolean;
  run(input: I, context: SkillContext): Promise<SkillRunResult<O>>;
};

export class SkillRegistry {
  private readonly definitions = new Map<string, SkillDefinition<any, any>>();

  register<I, O>(definition: SkillDefinition<I, O>): this {
    if (this.definitions.has(definition.id)) throw new Error(`SKILL_ALREADY_REGISTERED: ${definition.id}`);
    this.definitions.set(definition.id, definition);
    return this;
  }

  get<I = unknown, O = unknown>(id: string): SkillDefinition<I, O> | undefined {
    return this.definitions.get(id) as SkillDefinition<I, O> | undefined;
  }

  list(): Array<SkillDefinition<any, any>> {
    return [...this.definitions.values()];
  }
}

function asFailure(error: unknown): SkillFailure {
  if (error instanceof SkillRunError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.actionStatus ? { actionStatus: error.actionStatus } : {}),
    };
  }
  return {
    code: 'SKILL_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Maps a skill result to the controller's vocabulary; keeps busy/timeout distinct. */
export function skillStatusToController(result: SkillResult): ControllerStatus {
  switch (result.status) {
    case 'succeeded':
      return 'ok';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    case 'partial':
      return 'partial';
    case 'failed':
      if (result.error?.code === 'DEADLINE_EXCEEDED') return 'timeout';
      if (result.error?.actionStatus === 'busy') return 'busy';
      return 'error';
  }
}

/**
 * Runs one registered skill. It never retries and never selects a target; it
 * only validates input, supplies the bounded context and normalises evidence.
 */
export class SkillRunner {
  constructor(private readonly registry: SkillRegistry) {}

  async run<I = unknown, O = unknown>(
    id: string,
    params: unknown,
    context: SkillContext,
  ): Promise<SkillResult<O>> {
    const definition = this.registry.get<I, O>(id);
    if (!definition) {
      return {
        status: 'failed',
        error: { code: 'UNKNOWN_SKILL', message: `未注册的技能: ${id}` },
        evidence: [...context.evidence],
        progress: [...context.progress],
        partialEffects: [],
      };
    }

    const parsed = definition.inputSchema.safeParse(params);
    if (!parsed.success) {
      return {
        status: 'failed',
        error: { code: 'INVALID_SKILL_INPUT', message: parsed.error.message },
        evidence: [...context.evidence],
        progress: [...context.progress],
        partialEffects: [],
      };
    }

    try {
      context.check();
      const outcome = await definition.run(parsed.data, context);
      const actions = context.evidence.filter(
        (item): item is Extract<SkillEvidence, { kind: 'action' }> => item.kind === 'action',
      );
      return {
        ...outcome,
        evidence: [...context.evidence],
        progress: [...context.progress],
        partialEffects: [
          ...(outcome.partialEffects ?? []),
          ...actions
            .filter(item => item.action.status === 'succeeded')
            .map(item => `已完成动作: ${item.action.type}`),
        ],
      };
    } catch (error) {
      const failure = asFailure(error);
      const status: SkillStatus =
        context.signal.aborted || failure.code === 'CANCELLED' ? 'cancelled' : 'failed';
      const actions = context.evidence.filter(
        (item): item is Extract<SkillEvidence, { kind: 'action' }> => item.kind === 'action',
      );
      const deadlineExceeded = context.deadline !== undefined
        && Date.now() >= context.deadline
        && (failure.code === 'SKILL_FAILED' || failure.code === 'DEADLINE_EXCEEDED');
      return {
        status,
        ...(error instanceof SkillRunError && error.actionData !== undefined ? { output: error.actionData as O } : {}),
        ...(status === 'failed' && deadlineExceeded
          ? { error: { code: 'DEADLINE_EXCEEDED', message: '技能已达到截止时间' } }
          : { error: failure }),
        evidence: [...context.evidence],
        progress: [...context.progress],
        partialEffects: actions
          .filter(item => item.action.status === 'succeeded')
          .map(item => `已完成动作: ${item.action.type}`),
      };
    }
  }
}

export function createSkillContext(
  port: ActionPort,
  options: { signal: AbortSignal; deadline?: number; player?: string },
): SkillContext {
  const evidence: SkillEvidence[] = [];
  const progress: ControllerProgress[] = [];
  const check = () => {
    if (options.signal.aborted) {
      throw new SkillRunError(
        'CANCELLED',
        options.signal.reason instanceof Error ? options.signal.reason.message : '技能已取消',
      );
    }
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      throw new SkillRunError('DEADLINE_EXCEEDED', '技能已达到截止时间');
    }
  };

  return {
    signal: options.signal,
    ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
    ...(options.player ? { player: options.player } : {}),
    evidence,
    progress,
    check,
    query<T = unknown>(input: unknown): T {
      check();
      const outcome = port.query(input);
      if (outcome.status !== 'succeeded') {
        throw new SkillRunError(
          'OBSERVATION_UNAVAILABLE',
          `观测失败: ${outcome.status}${outcome.error ? ` (${String(outcome.error)})` : ''}`,
        );
      }
      evidence.push({ kind: 'observation', query: input, data: outcome.data });
      return outcome.data as T;
    },
    async execute(action: Action, executeOptions?: { timeoutMs?: number }): Promise<ActionResult> {
      check();
      const remaining = options.deadline === undefined
        ? 30_000
        : Math.max(1, Math.min(30_000, options.deadline - Date.now()));
      const timeoutMs = Math.max(1, Math.min(executeOptions?.timeoutMs ?? 30_000, remaining));
      const result = await port.execute(action, { signal: options.signal, timeoutMs });
      evidence.push({ kind: 'action', action: result });
      check();
      if (result.status !== 'succeeded') {
        throw new SkillRunError(
          result.error?.code ?? result.status.toUpperCase(),
          result.error?.message ?? `动作失败: ${result.status}`,
          result.status,
          result.data,
        );
      }
      return result;
    },
    report(message: string, data?: unknown): void {
      progress.push({ at: Date.now(), message, ...(data !== undefined ? { data } : {}) });
    },
  };
}
