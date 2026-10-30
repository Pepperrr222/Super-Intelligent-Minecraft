import { ActionError } from './executor.js';
import type { ActionResult, Condition } from './schema.js';
import type {
  ActionPort,
  ControllerCommand,
  ControllerPort,
  ControllerResult,
  ControllerStatus,
  EvidenceLevel,
  QueryOutcome,
} from './task.js';

const EVIDENCE_RANK: Record<EvidenceLevel, number> = {
  request_sent: 1,
  client_observed: 2,
  api_complete: 3,
  step_verified: 4,
};

type ConditionCheck =
  | { value: true }
  | { value: false | 'unknown'; code: string; message: string; observed?: unknown };

function evidenceOf(result: ActionResult): EvidenceLevel | undefined {
  if (result.status !== 'succeeded') return undefined;
  const raw = (result.data as { evidence?: unknown } | undefined)?.evidence;
  if (typeof raw !== 'string') return 'api_complete';
  if (raw.endsWith('_sent') || raw === 'attack_sent' || raw === 'interaction_sent') return 'request_sent';
  if (raw.includes('client') || raw.includes('position') || raw.includes('inventory')
    || raw.includes('observed') || raw.includes('food')) return 'client_observed';
  if (raw.includes('mineflayer') || raw.includes('completed') || raw.includes('elapsed')) return 'api_complete';
  return 'api_complete';
}

function bump(current: EvidenceLevel | undefined, next: EvidenceLevel | undefined): EvidenceLevel | undefined {
  if (!next) return current;
  return !current || EVIDENCE_RANK[next] > EVIDENCE_RANK[current] ? next : current;
}

/**
 * Executes exactly one task step. It owns no queue and never retries:
 * preconditions, the single action lease, cancellation, verification and
 * evidence are handled here; scheduling continues in TaskScheduler.
 */
export class ActionController implements ControllerPort {
  private active?: { command: ControllerCommand; abort: AbortController };

  constructor(private readonly actions: ActionPort) {}

  get busy(): boolean {
    return Boolean(this.active) || this.actions.busy;
  }

  stop(reason = '调度器取消'): void {
    this.active?.abort.abort(new ActionError('CANCELLED', reason));
    this.actions.stop(reason);
  }

  private result(
    command: ControllerCommand,
    status: ControllerStatus,
    partialEffects: ActionResult[],
    extra: Pick<ControllerResult, 'evidence' | 'data' | 'error'> = {},
  ): ControllerResult {
    return {
      taskId: command.taskId,
      planRevision: command.planRevision,
      stepId: command.step.id,
      status,
      partialEffects,
      leaseState: this.actions.busy ? 'held' : 'free',
      ...extra,
    };
  }

  async execute(command: ControllerCommand): Promise<ControllerResult> {
    if (this.active) {
      return this.result(command, 'busy', [], {
        error: { code: 'BUSY', message: '控制器已有步骤在执行' },
      });
    }
    if (this.actions.busy) {
      return this.result(command, 'busy', [], {
        error: { code: 'BUSY', message: '动作接口仍占用控制权' },
      });
    }
    if (command.signal?.aborted) {
      return this.result(command, 'cancelled', [], {
        error: { code: 'CANCELLED', message: '请求已经取消' },
      });
    }

    const abort = new AbortController();
    this.active = { command, abort };
    const partialEffects: ActionResult[] = [];
    let evidence: EvidenceLevel | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

    const externalAbort = () => {
      abort.abort(new ActionError('CANCELLED', '调用方取消'));
      this.actions.stop('调用方取消');
    };
    command.signal?.addEventListener('abort', externalAbort, { once: true });
    if (command.deadline !== undefined) {
      deadlineTimer = setTimeout(
        () => abort.abort(new ActionError('TIMEOUT', '步骤截止时间已到')),
        Math.max(0, command.deadline - Date.now()),
      );
    }

    try {
      const pre = this.checkConditions(command.step.preconditions, 'pre');
      if (pre.value !== true) {
        return this.result(command, 'blocked', partialEffects, {
          error: { code: pre.code, message: pre.message },
          data: pre.observed,
        });
      }

      for (const action of command.step.actions) {
        if (abort.signal.aborted) {
          return this.result(command, 'cancelled', partialEffects, {
            evidence,
            error: { code: 'CANCELLED', message: '步骤已取消' },
          });
        }
        if (command.deadline !== undefined && Date.now() >= command.deadline) {
          return this.result(command, 'timeout', partialEffects, {
            evidence,
            error: { code: 'DEADLINE_EXCEEDED', message: '步骤截止时间已到' },
          });
        }

        const actionResult = await this.actions.execute(action, {
          signal: abort.signal,
          timeoutMs: command.step.timeoutMs,
        });
        partialEffects.push(actionResult);
        evidence = bump(evidence, evidenceOf(actionResult));

        if (actionResult.status !== 'succeeded') {
          const mapped = this.mapFailure(actionResult, partialEffects);
          return this.result(command, mapped.status, partialEffects, {
            evidence,
            error: mapped.error,
            data: actionResult.data,
          });
        }
      }

      if (abort.signal.aborted) {
        return this.result(command, 'cancelled', partialEffects, {
          evidence,
          error: { code: 'CANCELLED', message: '步骤已取消' },
        });
      }
      if (command.deadline !== undefined && Date.now() >= command.deadline) {
        return this.result(command, 'timeout', partialEffects, {
          evidence,
          error: { code: 'DEADLINE_EXCEEDED', message: '步骤截止时间已到' },
        });
      }

      const post = this.checkConditions(command.step.postconditions, 'post');
      if (post.value !== true) {
        const status: ControllerStatus = post.value === 'unknown' ? 'blocked' : 'partial';
        return this.result(command, status, partialEffects, {
          evidence,
          error: { code: post.code, message: post.message },
          data: post.observed,
        });
      }

      const data = [...partialEffects].reverse().find(result => result.status === 'succeeded')?.data;
      return this.result(command, 'ok', partialEffects, { evidence: 'step_verified', data });
    } catch (error) {
      const cancelled = abort.signal.aborted;
      return this.result(
        command,
        cancelled ? 'cancelled' : 'error',
        partialEffects,
        {
          evidence,
          error: {
            code: cancelled ? 'CANCELLED' : 'CONTROLLER_EXCEPTION',
            message: error instanceof Error ? error.message : String(error),
          },
        },
      );
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      command.signal?.removeEventListener('abort', externalAbort);
      if (this.active?.abort === abort) this.active = undefined;
    }
  }

  private checkConditions(conditions: Condition[] | undefined, phase: 'pre' | 'post'): ConditionCheck {
    for (const condition of conditions ?? []) {
      let outcome: QueryOutcome;
      try {
        outcome = this.actions.query({ type: 'verify', condition });
      } catch (error) {
        return {
          value: 'unknown',
          code: `${phase.toUpperCase()}CONDITION_QUERY_FAILED`,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (outcome.status !== 'succeeded') {
        return {
          value: 'unknown',
          code: `${phase.toUpperCase()}CONDITION_QUERY_FAILED`,
          message: `查询状态为 ${outcome.status}`,
        };
      }
      const data = outcome.data as { value?: unknown; observed?: unknown } | undefined;
      if (data?.value === true) continue;
      if (data?.value === false) {
        return {
          value: false,
          code: `${phase.toUpperCase()}CONDITION_FAILED`,
          message: `条件不满足: ${condition.kind}`,
          observed: data.observed,
        };
      }
      return {
        value: 'unknown',
        code: `${phase.toUpperCase()}CONDITION_UNKNOWN`,
        message: `条件无法判定: ${condition.kind}`,
        observed: data?.observed,
      };
    }
    return { value: true };
  }

  private mapFailure(
    result: ActionResult,
    partialEffects: ActionResult[],
  ): { status: ControllerStatus; error: { code: string; message: string } } {
    const priorSuccess = partialEffects.some(item => item.status === 'succeeded');
    const partial = (status: ControllerStatus): ControllerStatus =>
      priorSuccess && (status === 'error' || status === 'timeout') ? 'partial' : status;

    switch (result.status) {
      case 'busy':
        return { status: 'busy', error: { code: 'BUSY', message: result.error?.message ?? '动作接口忙' } };
      case 'cancelled':
        return { status: 'cancelled', error: { code: 'CANCELLED', message: result.error?.message ?? '动作已取消' } };
      case 'timed_out':
        return {
          status: partial('timeout'),
          error: { code: result.error?.code ?? 'TIMEOUT', message: result.error?.message ?? '动作超时' },
        };
      case 'invalid':
        return {
          status: 'error',
          error: { code: 'INVALID_ACTION', message: result.error?.message ?? '动作参数不合法' },
        };
      case 'not_ready':
        return {
          status: 'blocked',
          error: { code: 'NOT_READY', message: result.error?.message ?? '机器人当前不可用' },
        };
      case 'failed':
        return {
          status: partial('error'),
          error: { code: result.error?.code ?? 'ACTION_FAILED', message: result.error?.message ?? '动作失败' },
        };
      case 'succeeded':
        return { status: 'ok', error: { code: 'UNEXPECTED', message: '不应到达的成功分支' } };
    }
  }
}
