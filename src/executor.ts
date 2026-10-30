import { randomUUID } from 'node:crypto';
import { actionSchema, type Action, type ActionResult } from './schema.js';

export class ActionError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export interface Context {
  signal: AbortSignal;
  check(): void;
  cleanup(fn: () => void): void;
  sleep(ms: number): Promise<void>;
}
export interface ExecuteOptions { signal?: AbortSignal; timeoutMs?: number }
type Lease = { id: string; abort: AbortController; action: Action };

/** One actuator owner. Cancellation returns promptly; the lease remains until native work settles. */
export class ActionExecutor {
  private lease?: Lease;
  constructor(private run: (action: Action, context: Context) => Promise<unknown>, private ready = () => true) {}
  get busy() { return Boolean(this.lease); }
  get waitingForDimension() { return this.lease?.action.type==='wait_until' && this.lease.action.condition.kind==='dimension_is'; }
  stop(reason = '用户停止') { this.lease?.abort.abort(new ActionError('CANCELLED', reason)); }

  async execute(input: unknown, options: ExecuteOptions = {}): Promise<ActionResult> {
    const id = randomUUID(), startedAt = Date.now();
    let type = 'unknown';
    const result = (status: ActionResult['status'], data?: unknown, error?: ActionResult['error']): ActionResult =>
      ({ id, type, status, startedAt, finishedAt: Date.now(), ...(data === undefined ? {} : { data }), ...(error ? { error } : {}) });
    const parsed = actionSchema.safeParse(input);
    if (!parsed.success) return result('invalid', undefined, { code: 'INVALID_ARGUMENT', message: parsed.error.message });
    const action = parsed.data;
    type = action.type;
    const timeout = options.timeoutMs ?? ('durationMs' in action ? action.durationMs + 5000 : 30_000);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300_000)
      return result('invalid', undefined, { code: 'INVALID_TIMEOUT', message: 'timeoutMs 必须在 1–300000 范围内' });
    if (options.signal?.aborted) return result('cancelled', undefined, { code: 'CANCELLED', message: '请求已经取消' });
    if (!this.ready()) return result('not_ready', undefined, { code: 'NOT_READY', message: '机器人未出生、已死亡或已断开连接' });
    if (this.lease) return result('busy', undefined, { code: 'BUSY', message: '前一个动作仍占用控制权；请等待其底层操作结束' });
    const lease = { id, abort: new AbortController(), action };
    this.lease = lease;
    const signal = lease.abort.signal;
    const cleanups: Array<() => void> = [];
    const clean = () => { while (cleanups.length) { try { cleanups.pop()!(); } catch { /* continue releasing other controls */ } } };
    const check = () => { if (signal.aborted) throw signal.reason; };
    const context: Context = {
      signal, check,
      cleanup(fn) { if (signal.aborted) fn(); else cleanups.push(fn); },
      sleep(ms) {
        check();
        return new Promise((resolve, reject) => {
          const finish = () => { signal.removeEventListener('abort', cancel); resolve(); };
          const timer = setTimeout(finish, ms);
          const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
          signal.addEventListener('abort', cancel, { once: true });
        });
      }
    };
    const externalCancel = () => lease.abort.abort(new ActionError('CANCELLED', '调用方取消'));
    options.signal?.addEventListener('abort', externalCancel, { once: true });
    const timer = setTimeout(() => lease.abort.abort(new ActionError('TIMEOUT', '动作执行超时')), timeout);
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => { clean(); reject(signal.reason); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const work = Promise.resolve().then(async () => { check(); const data = await this.run(action, context); check(); return data; });
    // Do not release early: equip/craft/container requests may still be in flight after cancellation.
    const release = () => { clean(); if (this.lease === lease) this.lease = undefined; };
    void work.then(release, release);
    try {
      const data = await Promise.race([work, cancelled]);
      check();
      return result('succeeded', data);
    } catch (error) {
      const cause = signal.aborted ? signal.reason : error;
      const code = cause instanceof ActionError ? cause.code : 'EXECUTION_FAILED';
      const message = cause instanceof Error ? cause.message : String(cause);
      return result(signal.aborted ? (code === 'TIMEOUT' ? 'timed_out' : 'cancelled') : 'failed', undefined, { code, message });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      options.signal?.removeEventListener('abort', externalCancel);
    }
  }
}
