import type {
  ControllerPort,
  ControllerResult,
  ControllerStatus,
  Task,
  TaskLedger,
  TaskRecord,
  TaskSnapshot,
  TaskState,
} from './task.js';

const TERMINAL: TaskState[] = ['completed', 'failed', 'cancelled', 'blocked'];

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** In-memory ledger. A durable implementation can implement TaskLedger later. */
export class MemoryTaskLedger implements TaskLedger {
  private readonly records = new Map<string, TaskRecord>();

  load(): TaskRecord[] {
    return [...this.records.values()].map(record => clone(record));
  }

  save(record: TaskRecord): void {
    this.records.set(record.task.id, clone(record));
  }

  remove(id: string): void {
    this.records.delete(id);
  }
}

/**
 * Owns task order, dependencies, retry policy and lifecycle.
 * It dispatches one step at a time and never calls the native action API directly.
 */
export class TaskScheduler {
  private readonly records = new Map<string, TaskRecord>();
  private running = false;

  constructor(
    private readonly controller: ControllerPort,
    private readonly ledger: TaskLedger = new MemoryTaskLedger(),
  ) {
    for (const record of this.ledger.load()) {
      this.records.set(record.task.id, record);
    }
    // A persisted "running" task cannot be trusted after a restart. Require an
    // explicit reconcile/resume instead of replaying it automatically.
    for (const record of this.records.values()) {
      if (record.state === 'running' || record.state === 'cancelling') {
        record.state = 'blocked';
        record.lastResult = this.terminalResult(
          record,
          'blocked',
          'RECOVERY_REQUIRED',
          '检测到上次未结束的任务；请先对账后 resume',
        );
        this.ledger.save(record);
      }
    }
  }

  submit(task: Task): TaskSnapshot {
    this.validate(task);
    if (this.records.has(task.id)) throw new Error(`TASK_ALREADY_EXISTS: ${task.id}`);
    for (const dependency of task.dependsOn ?? []) {
      if (!this.records.has(dependency)) throw new Error(`UNKNOWN_DEPENDENCY: ${dependency}`);
    }
    return this.insert(task);
  }

  /** Submit a task graph in any order; dependencies may reference tasks in the same batch. */
  submitAll(tasks: Task[]): TaskSnapshot[] {
    const newIds = new Set<string>();
    for (const task of tasks) {
      this.validate(task);
      if (this.records.has(task.id) || newIds.has(task.id)) {
        throw new Error(`TASK_ALREADY_EXISTS: ${task.id}`);
      }
      newIds.add(task.id);
    }
    for (const task of tasks) {
      for (const dependency of task.dependsOn ?? []) {
        if (dependency === task.id) throw new Error(`SELF_DEPENDENCY: ${task.id}`);
        if (!this.records.has(dependency) && !newIds.has(dependency)) {
          throw new Error(`UNKNOWN_DEPENDENCY: ${dependency}`);
        }
      }
    }
    return tasks.map(task => this.insert(task));
  }

  private insert(task: Task): TaskSnapshot {
    const record: TaskRecord = {
      task: clone(task),
      planRevision: 1,
      state: 'queued',
      currentStep: 0,
      attempts: 0,
      submittedAt: Date.now(),
    };
    this.records.set(task.id, record);
    this.ledger.save(record);
    return this.snapshot(record);
  }

  async runNext(): Promise<TaskSnapshot | undefined> {
    if (this.running || this.controller.busy) return undefined;
    this.markDependencyBlocks();

    const record = this.pickReady();
    if (!record) return undefined;

    if (record.task.deadline !== undefined && record.task.deadline <= Date.now()) {
      this.apply(record, this.terminalResult(record, 'error', 'DEADLINE_EXCEEDED', '任务已超过截止时间'));
      this.ledger.save(record);
      return this.snapshot(record);
    }

    const step = record.task.steps[record.currentStep];
    if (!step) {
      record.state = 'completed';
      this.ledger.save(record);
      return this.snapshot(record);
    }

    record.state = 'running';
    this.running = true;
    this.ledger.save(record);

    let result: ControllerResult;
    try {
      result = await this.controller.execute({
        taskId: record.task.id,
        planRevision: record.planRevision,
        step,
        deadline: record.task.deadline,
      });
    } catch (error) {
      result = this.terminalResult(
        record,
        'error',
        'CONTROLLER_EXCEPTION',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.running = false;
    }

    this.apply(record, result);
    this.ledger.save(record);
    return this.snapshot(record);
  }

  async runUntilIdle(maxSteps = 1000): Promise<TaskSnapshot[]> {
    const snapshots: TaskSnapshot[] = [];
    for (let index = 0; index < maxSteps; index++) {
      const snapshot = await this.runNext();
      if (!snapshot) break;
      snapshots.push(snapshot);
      if (snapshot.state === 'queued' && snapshot.lastResult?.status === 'busy') break;
    }
    return snapshots;
  }

  pause(id?: string): number {
    let changed = 0;
    for (const record of this.selected(id)) {
      if (record.state === 'queued') {
        record.state = 'paused';
        this.ledger.save(record);
        changed++;
      }
    }
    return changed;
  }

  resume(id?: string): number {
    let changed = 0;
    for (const record of this.selected(id)) {
      if (record.state === 'paused' || record.state === 'blocked') {
        record.state = 'queued';
        this.ledger.save(record);
        changed++;
      }
    }
    return changed;
  }

  cancel(id: string, reason = '用户取消'): boolean {
    const record = this.records.get(id);
    if (!record || TERMINAL.includes(record.state)) return false;

    if (record.state === 'running') {
      record.state = 'cancelling';
      record.lastResult = this.terminalResult(record, 'cancelled', 'CANCELLED', reason);
      this.ledger.save(record);
      this.controller.stop(reason);
      return true;
    }

    record.state = 'cancelled';
    record.lastResult = this.terminalResult(record, 'cancelled', 'CANCELLED', reason);
    this.ledger.save(record);
    return true;
  }

  stop(reason = '停止调度'): void {
    this.controller.stop(reason);
    for (const record of this.records.values()) {
      if (TERMINAL.includes(record.state)) continue;
      if (record.state === 'running') {
        record.state = 'cancelling';
      } else {
        record.state = 'cancelled';
      }
      record.lastResult = this.terminalResult(record, 'cancelled', 'CANCELLED', reason);
      this.ledger.save(record);
    }
  }

  get(id: string): TaskSnapshot | undefined {
    const record = this.records.get(id);
    return record ? this.snapshot(record) : undefined;
  }

  private selected(id?: string): TaskRecord[] {
    if (!id) return [...this.records.values()];
    const record = this.records.get(id);
    return record ? [record] : [];
  }

  list(): TaskSnapshot[] {
    return [...this.records.values()]
      .sort((a, b) => a.submittedAt - b.submittedAt)
      .map(record => this.snapshot(record));
  }

  private pickReady(): TaskRecord | undefined {
    const ready = [...this.records.values()].filter(record => {
      if (record.state !== 'queued') return false;
      return (record.task.dependsOn ?? []).every(id => this.records.get(id)?.state === 'completed');
    });
    ready.sort((a, b) => {
      const priority = (b.task.priority ?? 0) - (a.task.priority ?? 0);
      if (priority !== 0) return priority;
      const deadline = (a.task.deadline ?? Number.POSITIVE_INFINITY)
        - (b.task.deadline ?? Number.POSITIVE_INFINITY);
      if (deadline !== 0) return deadline;
      return a.submittedAt - b.submittedAt || a.task.id.localeCompare(b.task.id);
    });
    return ready[0];
  }

  private markDependencyBlocks(): void {
    for (const record of this.records.values()) {
      if (record.state !== 'queued') continue;
      const blockedBy = (record.task.dependsOn ?? []).find(id => {
        const state = this.records.get(id)?.state;
        return state === 'failed' || state === 'cancelled' || state === 'blocked';
      });
      if (!blockedBy) continue;
      record.state = 'blocked';
      record.lastResult = this.terminalResult(
        record,
        'blocked',
        'DEPENDENCY_FAILED',
        `依赖任务 ${blockedBy} 未成功完成`,
      );
      this.ledger.save(record);
    }
  }

  private apply(record: TaskRecord, result: ControllerResult): void {
    record.lastResult = result;
    if (record.state === 'cancelling') {
      record.state = 'cancelled';
      return;
    }

    switch (result.status) {
      case 'ok':
        record.currentStep++;
        record.attempts = 0;
        record.state = record.currentStep >= record.task.steps.length ? 'completed' : 'queued';
        return;
      case 'busy':
        // Busy is not a step failure: keep the step queued and let the caller
        // retry after the current native lease settles.
        record.state = 'queued';
        return;
      case 'cancelled':
        record.state = 'cancelled';
        return;
      case 'blocked':
        record.state = 'blocked';
        return;
      case 'timeout':
      case 'error':
      case 'partial': {
        record.attempts++;
        const step = record.task.steps[record.currentStep];
        const retry = step?.retry;
        const retryOn = retry?.retryOn ?? ['error', 'timeout'];
        const terminalCodes = new Set(['DEADLINE_EXCEEDED', 'RECOVERY_REQUIRED', 'DEPENDENCY_FAILED']);
        const eligible = result.status !== 'partial'
          && !terminalCodes.has(result.error?.code ?? '')
          && step?.idempotent === true
          && retry !== undefined
          && record.attempts < retry.maxAttempts
          && (result.status === 'timeout' ? retryOn.includes('timeout') : retryOn.includes('error'));
        record.state = eligible ? 'queued' : 'failed';
        return;
      }
    }
  }

  private terminalResult(
    record: TaskRecord,
    status: ControllerStatus,
    code: string,
    message: string,
  ): ControllerResult {
    return {
      taskId: record.task.id,
      planRevision: record.planRevision,
      stepId: record.task.steps[record.currentStep]?.id ?? 'unknown',
      status,
      partialEffects: [],
      error: { code, message },
      leaseState: 'free',
    };
  }

  private snapshot(record: TaskRecord): TaskSnapshot {
    return {
      id: record.task.id,
      state: record.state,
      currentStep: record.currentStep,
      totalSteps: record.task.steps.length,
      attempts: record.attempts,
      priority: record.task.priority ?? 0,
      deadline: record.task.deadline,
      dependsOn: [...(record.task.dependsOn ?? [])],
      submittedAt: record.submittedAt,
      lastResult: record.lastResult ? clone(record.lastResult) : undefined,
    };
  }

  private validate(task: Task): void {
    if (!task.id.trim()) throw new Error('INVALID_TASK_ID');
    if (!Array.isArray(task.steps) || task.steps.length === 0) throw new Error('TASK_NEEDS_STEPS');
    if (task.priority !== undefined && !Number.isFinite(task.priority)) throw new Error('INVALID_PRIORITY');
    if (task.deadline !== undefined && !Number.isFinite(task.deadline)) throw new Error('INVALID_DEADLINE');

    const stepIds = new Set<string>();
    for (const step of task.steps) {
      if (!step.id.trim()) throw new Error('INVALID_STEP_ID');
      if (stepIds.has(step.id)) throw new Error(`DUPLICATE_STEP_ID: ${step.id}`);
      stepIds.add(step.id);
      if (!Array.isArray(step.actions) || step.actions.length === 0) {
        throw new Error(`STEP_NEEDS_ACTIONS: ${step.id}`);
      }
      if (step.timeoutMs !== undefined
        && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > 300_000)) {
        throw new Error(`INVALID_STEP_TIMEOUT: ${step.id}`);
      }
      if (step.retry) {
        if (!Number.isInteger(step.retry.maxAttempts) || step.retry.maxAttempts < 1) {
          throw new Error(`INVALID_RETRY: ${step.id}`);
        }
        if (step.retry.maxAttempts > 1 && step.idempotent !== true) {
          throw new Error(`RETRY_REQUIRES_IDEMPOTENT: ${step.id}`);
        }
        if (step.retry.retryOn?.some(value => value !== 'error' && value !== 'timeout')) {
          throw new Error(`INVALID_RETRY_ON: ${step.id}`);
        }
      }
    }
  }
}
