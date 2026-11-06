import type { RunFeedbackV1 } from './brain-contract.js';
import type { FailureEntry } from './brain-feedback.js';

export type GoalStatus = 'active' | 'completed' | 'failed' | 'blocked' | 'partial' | 'cancelled';

export type GoalState = {
  goalId: string;
  owner: string;
  sourceText: string;
  goal: string | null;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  planRevision: number;
  replans: number;
  turns: number;
  lastFeedbackSeq: number;
  failures: Record<string, number>;
  failureCalls: Record<string, string>;
  blocked: string[];
  budget: { maxSteps: number; maxSeconds: number; deadline: number };
};

export type GoalStart = {
  owner: string;
  sourceText: string;
  goal: string | null;
  maxSteps?: number;
  maxSeconds?: number;
  now?: number;
};

const OPEN: GoalStatus[] = ['active', 'failed', 'blocked', 'partial'];

/**
 * In-memory, single-active-goal manager. It never decides what to execute; it
 * only bounds replanning and remembers which skill+params calls failed twice.
 */
export class GoalManager {
  private current?: GoalState;
  private feedbackSeq = 0;
  private sequence = 0;

  constructor(private readonly limits = { maxReplans: 2, maxTurns: 6 }) {}

  get active(): GoalState | undefined {
    return this.current && OPEN.includes(this.current.status) ? this.current : undefined;
  }

  get state(): GoalState | undefined {
    return this.current;
  }

  begin(input: GoalStart): GoalState | undefined {
    if (this.active) return undefined;
    const now = input.now ?? Date.now();
    this.sequence++;
    this.current = {
      goalId: `goal-${this.sequence}-${now}`,
      owner: input.owner,
      sourceText: input.sourceText,
      goal: input.goal,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      planRevision: 0,
      replans: 0,
      turns: 0,
      lastFeedbackSeq: 0,
      failures: {},
      failureCalls: {},
      blocked: [],
      budget: {
        maxSteps: input.maxSteps ?? 4,
        maxSeconds: input.maxSeconds ?? 120,
        deadline: now + (input.maxSeconds ?? 120) * 1000,
      },
    };
    return this.current;
  }

  /** Count one decision turn for the current goal; false means the turn budget is spent. */
  turn(now = Date.now()): boolean {
    const goal = this.active;
    if (!goal) return true;
    if (goal.turns >= this.limits.maxTurns) return false;
    goal.turns++;
    goal.updatedAt = now;
    return true;
  }

  canReplan(now = Date.now()): boolean {
    const goal = this.active;
    if (!goal) return false;
    if (goal.replans >= this.limits.maxReplans) return false;
    if (goal.turns >= this.limits.maxTurns) return false;
    goal.updatedAt = now;
    return true;
  }

  noteReplan(now = Date.now()): boolean {
    if (!this.canReplan(now)) return false;
    const goal = this.active!;
    goal.replans++;
    goal.planRevision++;
    goal.status = 'active';
    goal.updatedAt = now;
    return true;
  }

  /**
   * Record verified feedback, update repeated-failure counts and return the
   * feedback with `repeatedFailure` filled in by the program.
   */
  record(
    feedback: RunFeedbackV1,
    entries: readonly FailureEntry[] = [],
    calls: readonly string[] = [],
    now = Date.now(),
  ): RunFeedbackV1 {
    this.feedbackSeq++;
    const goal = this.active;
    if (!goal) return feedback;
    goal.lastFeedbackSeq = this.feedbackSeq;
    goal.updatedAt = now;

    if (feedback.outcome === 'completed') {
      for (const call of calls) {
        for (const [key, mapped] of Object.entries(goal.failureCalls)) {
          if (mapped === call) {
            delete goal.failures[key];
            delete goal.failureCalls[key];
          }
        }
      }
      goal.blocked = goal.blocked.filter(call => !calls.includes(call));
      goal.status = 'completed';
    } else {
      goal.status = feedback.outcome === 'timeout' ? 'failed' : feedback.outcome;
    }

    let repeated = feedback.repeatedFailure;
    for (const entry of entries) {
      const count = (goal.failures[entry.failure] ?? 0) + 1;
      goal.failures[entry.failure] = count;
      goal.failureCalls[entry.failure] = entry.call;
      if (count >= 2 && !goal.blocked.includes(entry.call)) goal.blocked.push(entry.call);
      if (count >= 2) repeated = true;
    }
    return { ...feedback, repeatedFailure: repeated };
  }

  blockedCalls(): string[] {
    return [...(this.current?.blocked ?? [])];
  }

  finish(status: GoalStatus, now = Date.now()): void {
    if (!this.current) return;
    this.current.status = status;
    this.current.updatedAt = now;
    // Terminal states close the goal so an explicit new player goal can begin;
    // 'active' keeps it open for a bounded follow-up.
    if (status !== 'active') this.current = undefined;
  }

  reset(): void {
    this.current = undefined;
    this.feedbackSeq = 0;
  }
}
