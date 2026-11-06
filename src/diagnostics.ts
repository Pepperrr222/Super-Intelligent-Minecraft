import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type DiagnosticStage = 'input' | 'model' | 'validation' | 'dispatch' | 'scheduler' | 'controller' | 'observation' | 'action' | 'feedback' | 'reply' | 'runtime';
export type DiagnosticState = 'start' | 'ok' | 'error' | 'blocked' | 'cancelled' | 'info';
export type DiagnosticEvent = { seq: number; sessionId: string; traceId: string; at: number; stage: DiagnosticStage;
  state: DiagnosticState; label: string; data?: unknown; taskId?: string; durationMs?: number };
type Scope = { traceId: string; taskId?: string };

/** Redaction occurs before memory, disk and HTTP, including arbitrary model text. */
export function diagnosticData(value: unknown, depth = 0): unknown {
  if (depth > 7) return '[深度截断]';
  if (typeof value === 'string') {
    const safe = value.replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9_\-.]{8,}/giu, '[凭据已脱敏]')
      .replace(/((?:["']?(?:api[_-]?key|password|authorization|access[_-]?token)["']?)\s*[=:]\s*["']?)[^\s,;"'}]+/giu, '$1[已脱敏]');
    return safe.length > 6000 ? safe.slice(0, 6000) + '[字符串已截断]' : safe;
  }
  if (value instanceof Error) return { name: value.name, message: diagnosticData(value.message) };
  if (Array.isArray(value)) return value.slice(0, 64).map(entry => diagnosticData(entry, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, entry]) => [key,
    /^(?:api.?key|authorization|password|secret|token|access.?token|refresh.?token|nbt|components|removedComponents|fingerprint|uuid)$/iu.test(key)
      ? '[已脱敏]' : diagnosticData(entry, depth + 1)]));
  return typeof value === 'bigint' ? value.toString() : value;
}

export class DiagnosticBus {
  private readonly scope = new AsyncLocalStorage<Scope>();
  private readonly tasks = new Map<string, Scope>();
  private events: DiagnosticEvent[] = [];
  private sequence = 0;
  private offset = 0;
  private pendingLine = '';
  private decoder = new StringDecoder('utf8');
  readonly sessionId = randomUUID();
  storageNote: string | null = null;
  constructor(readonly options: { file?: string; maxEvents?: number; readOnly?: boolean } = {}) {
    if (options.file) try {
      mkdirSync(dirname(options.file), { recursive: true });
      if (existsSync(options.file) && statSync(options.file).size < 21 * 1024 * 1024) {
        const lines = readFileSync(options.file, 'utf8').split('\n');
        this.offset = statSync(options.file).size;
        this.pendingLine = lines.at(-1) ?? '';
        for (const line of lines.slice(0, -1).slice(-2000)) try {
          const event = JSON.parse(line) as DiagnosticEvent;
          if (Number.isInteger(event.seq) && typeof event.traceId === 'string' && typeof event.stage === 'string') {
            this.events.push(diagnosticData(event) as DiagnosticEvent); this.sequence = Math.max(this.sequence, event.seq);
          }
        } catch { /* incomplete final line is ignored */ }
      }
    } catch { this.storageNote = '日志文件不可读，使用内存记录'; }
    this.events = this.events.slice(-(options.maxEvents ?? 2000));
  }
  private refresh() {
    if (!this.options.readOnly || !this.options.file || !existsSync(this.options.file)) return;
    let fd: number | undefined;
    try {
      const size = statSync(this.options.file).size;
      if (size < this.offset) { this.offset = 0; this.pendingLine = ''; this.decoder = new StringDecoder('utf8'); }
      if (size >= 20 * 1024 * 1024) this.storageNote = '日志文件达到20MB上限，归档文件并重启伙伴后继续写入';
      if (size === this.offset) return;
      fd = openSync(this.options.file, 'r');
      const buffer = Buffer.alloc(Math.min(size - this.offset, 2 * 1024 * 1024));
      const read = readSync(fd, buffer, 0, buffer.length, this.offset); this.offset += read;
      const lines = (this.pendingLine + this.decoder.write(buffer.subarray(0, read))).split('\n');
      this.pendingLine = lines.pop() ?? '';
      for (const line of lines) try {
        const event = JSON.parse(line) as DiagnosticEvent;
        if (Number.isInteger(event.seq) && typeof event.traceId === 'string' && typeof event.stage === 'string') {
          this.events.push(diagnosticData(event) as DiagnosticEvent); this.sequence = Math.max(this.sequence, event.seq);
        }
      } catch { /* ignore a malformed line, never execute imported data */ }
      this.events = this.events.slice(-(this.options.maxEvents ?? 2000));
    } catch { this.storageNote = '读取运行日志失败，请稍后刷新'; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  run<T>(scope: Scope, work: () => T): T { return this.scope.run(scope, work); }
  message<T>(player: string, text: string, work: () => T): T {
    return this.run({ traceId: randomUUID() }, () => {
      this.emit('input', 'info', '玩家原始指令', { player, text }); return work();
    });
  }
  bindTask(taskId: string) {
    this.tasks.set(taskId, this.scope.getStore() ?? { traceId: randomUUID() });
    while (this.tasks.size > 2000) this.tasks.delete(this.tasks.keys().next().value!);
  }
  task<T>(taskId: string, work: () => T): T {
    return this.run({ ...(this.tasks.get(taskId) ?? this.scope.getStore() ?? { traceId: randomUUID() }), taskId }, work);
  }
  emit(stage: DiagnosticStage, state: DiagnosticState, label: string, data?: unknown, durationMs?: number) {
    try {
      const scope = this.scope.getStore() ?? { traceId: 'runtime' };
      const event: DiagnosticEvent = { seq: ++this.sequence, sessionId: this.sessionId, ...scope, at: Date.now(), stage, state,
        label, ...(data !== undefined ? { data: diagnosticData(data) } : {}), ...(durationMs !== undefined ? { durationMs } : {}) };
      // Bound each record without cutting a JSON object in the middle.
      if (JSON.stringify(event).length > 24000) event.data = { truncated: true, note: '记录超过24KB，请按更小批次复现' };
      this.events.push(event); this.events = this.events.slice(-(this.options.maxEvents ?? 2000));
      if (this.options.file && !this.options.readOnly) try {
        if (!existsSync(this.options.file) || statSync(this.options.file).size < 20 * 1024 * 1024) appendFileSync(this.options.file, JSON.stringify(event) + '\n');
        else this.storageNote = '日志已达20MB上限，仅继续保留内存记录；可导出后归档文件';
      } catch { this.storageNote = '日志写入失败，仍保留内存记录'; }
    } catch { /* Diagnostics must never alter actuator outcomes. */ }
  }
  async span<T>(stage: DiagnosticStage, label: string, data: unknown, work: () => Promise<T>): Promise<T> {
    const started = Date.now(); this.emit(stage, 'start', label, data);
    try {
      const result = await work();
      const status = (result as { status?: string; state?: string } | null)?.status;
      const state = ['failed', 'error', 'invalid', 'not_ready', 'timed_out', 'partial'].includes(status ?? '') ? 'error'
        : status === 'cancelled' ? 'cancelled' : ['blocked', 'busy'].includes(status ?? '') ? 'blocked' : 'ok';
      this.emit(stage, state, label, result, Date.now() - started); return result;
    } catch (error) { this.emit(stage, 'error', label, error, Date.now() - started); throw error; }
  }
  snapshot(after = 0) {
    this.refresh();
    return { sessionId: this.sessionId, lastSeq: this.sequence, firstSeq: this.events[0]?.seq ?? 0,
      storageNote: this.storageNote, events: this.events.filter(event => event.seq > after) };
  }
}
