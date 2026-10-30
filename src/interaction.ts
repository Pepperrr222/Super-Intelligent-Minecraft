import { SkillCatalog } from './skills.js';
import { boundedComplete, parseJsonObject } from './brain.js';
import type { LlmClient } from './llm.js';
import type { Action } from './schema.js';
import type {
  ControllerPort,
  Task,
  TaskSnapshot,
} from './task.js';

export type PlayerMessage = {
  id: string;
  player: string;
  text: string;
  receivedAt: number;
  channel?: 'chat' | 'whisper' | 'console';
};

/** Chat must not use the action lease: a long task cannot block replies. */
export interface ChatTransport {
  onMessage(handler: (message: PlayerMessage) => void): () => void;
  send(player: string, text: string): void;
}

export type TargetRef =
  | { kind: 'player'; name: string }
  | { kind: 'entity'; id: number }
  | { kind: 'block'; position: { x: number; y: number; z: number } }
  | { kind: 'position'; position: { x: number; y: number; z: number } };

export type ActionIntent = {
  kind: 'action';
  command: string;
  target?: TargetRef;
  params?: Record<string, unknown>;
};

export type Intent =
  | { kind: 'control.stop'; reason?: string }
  | { kind: 'control.pause' | 'control.resume' | 'control.cancel'; taskId?: string }
  | { kind: 'query'; question: string; scope?: 'inventory' | 'world' | 'task' | 'status' | 'help' }
  | ActionIntent
  | { kind: 'task' | 'plan'; goal: string; constraints?: string[] }
  | { kind: 'skill'; skill: string; params: unknown }
  | { kind: 'chat' | 'direct.reply'; text: string }
  | { kind: 'clarify'; question: string };

export type IntentEnvelope = {
  intent: Intent;
  confidence: number;
  rawText: string;
};

export type SessionSnapshot = {
  player: string;
  lastTaskId?: string;
  lastIntent?: Intent;
  pending?: PendingInteraction;
  recent: Array<{ role: 'player' | 'agent'; text: string; at: number }>;
};

export type PendingInteraction =
  | { kind: 'clarify'; question: string; createdAt: number; expiresAt: number }
  | { kind: 'confirm'; prompt: string; task: Task; createdAt: number; expiresAt: number };

type PendingInput =
  | { kind: 'clarify'; question: string }
  | { kind: 'confirm'; prompt: string; task: Task };

export interface IntentClassifier {
  classify(input: {
    message: PlayerMessage;
    session: SessionSnapshot;
    currentTask?: TaskSnapshot;
  }): Promise<IntentEnvelope>;
}

export type BrainInput = {
  message: PlayerMessage;
  intent: Intent;
  session: SessionSnapshot;
  currentTask?: TaskSnapshot;
  signal?: AbortSignal;
};

export type BrainOutput =
  | { kind: 'reply'; text: string }
  | { kind: 'task'; task: Task; ack?: string; confirmation?: string }
  | { kind: 'clarify'; question: string };

export interface BrainPort {
  handle(input: BrainInput): Promise<BrainOutput>;
}

export type ActionResolution =
  | { kind: 'actions'; actions: Action[] }
  | { kind: 'clarify'; question: string }
  | { kind: 'blocked'; reason: string };

export interface ActionResolverPort {
  resolve(input: {
    message: PlayerMessage;
    intent: ActionIntent;
    session: SessionSnapshot;
  }): Promise<ActionResolution>;
}

/** Structural subset of TaskScheduler used by the interaction layer. */
export interface SchedulerPort {
  submit(task: Task): TaskSnapshot;
  get(id: string): TaskSnapshot | undefined;
  list(): TaskSnapshot[];
  pause(id?: string): number;
  resume(id?: string): number;
  cancel(id: string, reason?: string): boolean;
  stop(reason?: string): void;
  runUntilIdle?(maxSteps?: number): Promise<TaskSnapshot[]>;
}

export type InteractionConfig = {
  /** Empty means local development mode: every player is treated as owner. */
  owners: string[];
  allowGuests: boolean;
  maxMessageLength: number;
  rateLimit: { windowMs: number; max: number };
  pendingTtlMs: number;
  autoRun: boolean;
  botName?: string;
};

export const DEFAULT_INTERACTION_CONFIG: InteractionConfig = {
  owners: [],
  allowGuests: true,
  maxMessageLength: 300,
  rateLimit: { windowMs: 10_000, max: 8 },
  pendingTtlMs: 120_000,
  autoRun: true,
};

type SessionState = {
  player: string;
  lastTaskId?: string;
  lastTaskOwner?: string;
  lastIntent?: Intent;
  pending?: PendingInteraction;
  recent: Array<{ role: 'player' | 'agent'; text: string; at: number }>;
  lastMessageAt: number;
};

const STOP = /^(停|停下|停下来|停止|别动|别走了|stop|halt)/i;
const PAUSE = /^(暂停|先停一下|等一下|等等|pause)(吧|啊|!|！|。|\.|\s)*$/i;
const RESUME = /^(继续|接着做|恢复|resume)(吧|啊|!|！|。|\.|\s)*$/i;
const CANCEL = /^(取消|取消任务|不做了|别做了|cancel)(吧|啊|!|！|。|\.|\s)*$/i;
const STATUS = /(状态|进度|到哪|在做什么|任务怎么样|status)/i;
const HELP = /(帮助|help|你能做什么|会什么|怎么用)/i;
const INVENTORY = /(背包|物品|有多少|带了什么|inventory)/i;
const COMPLEX = /(先.{1,40}(再|然后|接着)|(?:建造|建个|建一|build|construct).*(?:房|屋|house|base)|收集|采集|挖(?:矿|木|树)|制作|合成|熔炼|整理|collect|gather|craft|smelt|mine|build|make\s+(?:a|an)|destroy|拆除|丢弃|attack)/iu;
const TASK_VERB = /(建|造|收集|挖|采|做|去|拿|给|找|跟随|跟着|过来|制作|整理|熔炼)/;
const YES = /^(是|好|可以|确认|开始|执行|yes|y|ok|okay)(吧|啊|!|！|。|\.|\s)*$/i;
const NO = /^(不|不要|取消|算了|no|n)(吧|啊|!|！|。|\.|\s)*$/i;

export function isStopCommand(text: string): boolean {
  return STOP.test(text.trim());
}

export class RuleBasedIntentClassifier implements IntentClassifier {
  async classify(input: { message: PlayerMessage }): Promise<IntentEnvelope> {
    const text = input.message.text.trim();
    const base = { rawText: text, confidence: 0.95 };
    if (STOP.test(text)) return { ...base, intent: { kind: 'control.stop' } };
    if (PAUSE.test(text)) return { ...base, intent: { kind: 'control.pause' } };
    if (RESUME.test(text)) return { ...base, intent: { kind: 'control.resume' } };
    if (CANCEL.test(text)) return { ...base, intent: { kind: 'control.cancel' } };
    if (/^(帮助|help|你能做什么|会什么|怎么用)[?？!！。\s]*$/iu.test(text)) return { ...base, intent: { kind: 'query', question: text, scope: 'help' } };
    if (/^(状态|进度|status)[?？!！。\s]*$/iu.test(text)) return { ...base, intent: { kind: 'query', question: text, scope: 'status' } };
    if (/^(?:跟着|跟随)(?:他|她|它|他们|她们)|^follow\s+(?:him|her|them)\b/iu.test(text)) return { ...base, intent: { kind: 'clarify', question: '你想让我跟着谁？请明确目标。' } };
    if (COMPLEX.test(text)) return { ...base, intent: { kind: 'plan', goal: text } };
    const match = new SkillCatalog().match(text);
    if (match) return { ...base, intent: { kind: 'skill', skill: match.id, params: match.params } };
    if (INVENTORY.test(text)) return { ...base, intent: { kind: 'query', question: text, scope: 'inventory' } };
    if (TASK_VERB.test(text)) {
      return { ...base, confidence: 0.65, intent: { kind: 'plan', goal: text } };
    }
    if (/[?？]$/.test(text)) {
      return { ...base, confidence: 0.55, intent: { kind: 'query', question: text } };
    }
    return { ...base, confidence: 0.4, intent: { kind: 'chat', text } };
  }
}

/** Rule-first routing with a bounded, structured fallback for ambiguous messages. */
export class IntentRouter extends RuleBasedIntentClassifier {
  constructor(private readonly fastLlm?: LlmClient, private readonly timeoutMs = 1800) { super(); }
  override async classify(input: { message: PlayerMessage; session?: SessionSnapshot; currentTask?: TaskSnapshot }): Promise<IntentEnvelope> {
    const rule = await super.classify(input);
    if (rule.intent.kind !== 'chat' || /^(你好|嗨|hello|hi)[!！。\s]*$/iu.test(rule.rawText) || !this.fastLlm) return rule;
    try {
      const parsed = parseJsonObject(await boundedComplete(this.fastLlm, { system: 'Classify the player message. Return only JSON: {"kind":"reply","text":"..."}, {"kind":"skill","skill":"follow_player|come_to_player|navigate_to|report_inventory","params":{}}, {"kind":"plan","goal":"..."}, or {"kind":"clarify","question":"..."}. Never invent targets or coordinates. navigate_to params require x,y,z integers. Use clarify for uncertain references.', user: JSON.stringify({ message: rule.rawText, recent: input.session?.recent.slice(-8), currentTask: input.currentTask ? { state: input.currentTask.state } : null }), maxTokens: 250, temperature: 0.1 }, this.timeoutMs));
      if (parsed?.kind === 'skill' && typeof parsed.skill === 'string' && new SkillCatalog().get(parsed.skill)?.params.safeParse(parsed.params).success) {
        const matched = new SkillCatalog().match(rule.rawText);
        if (matched && matched.id === parsed.skill) return { ...rule, intent: { kind: 'skill', skill: matched.id, params: matched.params } };
        return { ...rule, intent: { kind: 'clarify', question: '请明确目标，例如“跟着我”或“走到坐标 2 64 2”。' } };
      }
      if (parsed?.kind === 'plan' && typeof parsed.goal === 'string' && parsed.goal.trim()) return { ...rule, intent: { kind: 'plan', goal: parsed.goal } };
      if (parsed?.kind === 'clarify' && typeof parsed.question === 'string') return { ...rule, intent: { kind: 'clarify', question: parsed.question } };
      if (parsed?.kind === 'reply' && typeof parsed.text === 'string') return { ...rule, intent: { kind: 'direct.reply', text: parsed.text } };
    } catch { /* deterministic fallback */ }
    return { ...rule, intent: { kind: 'direct.reply', text: '我目前会跟随、过来、坐标导航和查背包。' } };
  }
}

/**
 * Player-facing boundary. It never executes an Action directly; it only routes
 * intent to Controller / Scheduler / Brain and renders replies through ChatTransport.
 */
export class InteractionService {
  private readonly sessions = new Map<string, SessionState>();
  private readonly rates = new Map<string, number[]>();
  private readonly seen = new Map<string, number>();
  private unsubscribe?: () => void;
  private planning?: { controller: AbortController; player: string };
  private generation = 0;
  private messageSequence = 0;
  private latestGoalSequence = 0;
  private readonly config: InteractionConfig;

  constructor(
    private readonly transport: ChatTransport,
    private readonly classifier: IntentClassifier,
    private readonly brain: BrainPort,
    private readonly scheduler: SchedulerPort,
    private readonly controller: ControllerPort,
    private readonly actionResolver?: ActionResolverPort,
    config: Partial<InteractionConfig> = {},
  ) {
    this.config = { ...DEFAULT_INTERACTION_CONFIG, ...config };
  }

  start(): () => void {
    this.unsubscribe?.();
    this.unsubscribe = this.transport.onMessage(message => {
      void this.handle(message).catch(error => {
        this.respond(message.player, `交互失败：${error instanceof Error ? error.message : String(error)}`);
      });
    });
    return () => this.stop();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.cancelPlanning();
  }

  async handle(message: PlayerMessage): Promise<void> {
    const now = Date.now();
    const sequence = ++this.messageSequence;
    const text = message.text.trim();
    if (this.config.botName && message.player === this.config.botName) return;
    if (!text) return;
    if (text.length > this.config.maxMessageLength) {
      this.respond(message.player, '消息太长，请缩短后再说。');
      return;
    }
    if (this.isDuplicate(message, now)) return;
    if (!isStopCommand(text) && !PAUSE.test(text) && !RESUME.test(text) && !CANCEL.test(text) && !this.allowRate(message.player, now)) {
      this.respond(message.player, '慢一点，我还在处理上一条。');
      return;
    }

    const session = this.session(message.player, now);
    session.lastMessageAt = now;
    this.remember(session, 'player', text, now);

    // Stop is the only command allowed to bypass classifier and pending state.
    if (isStopCommand(text)) {
      if (!this.canStop(message.player, session)) {
        this.respond(message.player, '只有 owner 或当前任务发起者能停。');
        return;
      }
      this.cancelPlanning();
      for (const other of this.sessions.values()) this.clearPending(other);
      this.scheduler.stop('玩家停止');
      this.respond(message.player, '已停。');
      return;
    }

    const fastControl: Intent | undefined = PAUSE.test(text) ? { kind: 'control.pause' } : RESUME.test(text) ? { kind: 'control.resume' } : CANCEL.test(text) ? { kind: 'control.cancel' } : HELP.test(text) && /^(帮助|help|你能做什么|会什么|怎么用)[?？!！。\s]*$/iu.test(text) ? { kind: 'query', question: text, scope: 'help' } : STATUS.test(text) && /^(状态|进度|status)[?？!！。\s]*$/iu.test(text) ? { kind: 'query', question: text, scope: 'status' } : undefined;
    if (fastControl) {
      if (!this.allowed(message.player, fastControl)) { this.respond(message.player, '只有 owner 能让我执行任务或控制动作；聊天和查询可以继续。'); return; }
      if (fastControl.kind === 'control.cancel' && this.planning) { this.cancelPlanning(); this.clearPending(session); const id = session.lastTaskId; if (id) this.scheduler.cancel(id, '玩家取消'); this.respond(message.player, '已取消。'); return; }
      if (fastControl.kind === 'control.cancel') { this.cancelPlanning(); this.clearPending(session); }
      await this.route(fastControl, message, session);
      return;
    }

    if (session.pending) {
      if (now >= session.pending.expiresAt) {
        this.clearPending(session);
      } else if (session.pending.kind === 'confirm') {
        if (YES.test(text)) {
          const task = session.pending.task;
          this.clearPending(session);
          this.submitTask(task, message.player, '好，开始。');
          return;
        }
        if (NO.test(text)) {
          this.clearPending(session);
          this.respond(message.player, '好，取消。');
          return;
        }
        this.respond(message.player, '请回答“是/开始”或“不/取消”。');
        return;
      } else {
        // The next message is the answer to a clarification. Clear it and
        // classify the new text; an LLM classifier can use session history.
        this.clearPending(session);
      }
    }

    let envelope: IntentEnvelope;
    const generation = this.generation;
    try {
      envelope = await this.classifier.classify({
        message,
        session: this.snapshot(session),
        currentTask: session.lastTaskId ? this.scheduler.get(session.lastTaskId) : undefined,
      });
    } catch (error) {
      this.respond(message.player, `没听懂：${error instanceof Error ? error.message : String(error)}。换个说法？`);
      return;
    }

    if (generation !== this.generation) return;
    if (!this.allowed(message.player, envelope.intent)) {
      this.respond(message.player, '只有 owner 能让我执行任务或控制动作；聊天和查询可以继续。');
      return;
    }

    if (envelope.intent.kind === 'skill' && envelope.intent.skill !== 'report_inventory' || envelope.intent.kind === 'plan' || envelope.intent.kind === 'task' || envelope.intent.kind === 'action') {
      if (sequence < this.latestGoalSequence) return;
      this.latestGoalSequence = sequence;
    }
    session.lastIntent = envelope.intent;
    await this.route(envelope.intent, message, session);
  }

  private async route(intent: Intent, message: PlayerMessage, session: SessionState): Promise<void> {
    switch (intent.kind) {
      case 'control.stop':
        this.cancelPlanning();
        this.scheduler.stop(intent.reason ?? '玩家停止');
        this.respond(message.player, '已停。');
        return;
      case 'control.pause': {
        const changed = this.scheduler.pause(intent.taskId ?? session.lastTaskId);
        this.respond(message.player, changed ? '已暂停。' : '当前没有可暂停的任务。');
        return;
      }
      case 'control.resume': {
        const changed = this.scheduler.resume(intent.taskId ?? session.lastTaskId);
        this.respond(message.player, changed ? '已继续。' : '当前没有可继续的任务。');
        return;
      }
      case 'control.cancel': {
        const id = intent.taskId ?? session.lastTaskId;
        const changed = id ? this.scheduler.cancel(id, '玩家取消') : false;
        this.respond(message.player, changed ? '已取消。' : '当前没有可取消的任务。');
        return;
      }
      case 'query':
        if (intent.scope === 'help') {
          this.respond(message.player, '可以让我：跟着你、导航、挖/放方块、合成、存取物品、熔炼、交易，或者描述一个任务。说“停”会立即停止。');
          return;
        }
        if (intent.scope === 'status' || intent.scope === 'task') {
          this.respond(message.player, this.statusText(session));
          return;
        }
        await this.handleBrain(intent, message, session);
        return;
      case 'plan': {
        this.cancelPlanning();
        const controller = new AbortController();
        this.planning = { controller, player: message.player };
        this.respond(message.player, '收到，我先规划一下。');
        void this.handleBrain(intent, message, session, controller.signal).catch(() => { if (!controller.signal.aborted) this.respond(message.player, '规划失败，请稍后重试。'); }).finally(() => { if (this.planning?.controller === controller) this.planning = undefined; });
        return;
      }
      case 'skill':
        if (intent.skill !== 'report_inventory') this.cancelPlanning();
        await this.handleBrain(intent, message, session);
        return;
      case 'direct.reply':
        this.respond(message.player, intent.text);
        return;
      case 'task':
      case 'chat':
        await this.handleBrain(intent, message, session);
        return;
      case 'action':
        await this.handleAction(intent, message, session);
        return;
      case 'clarify':
        this.setPending(session, { kind: 'clarify', question: intent.question });
        this.respond(message.player, intent.question);
        return;
    }
  }

  private async handleBrain(intent: Intent, message: PlayerMessage, session: SessionState, signal?: AbortSignal): Promise<void> {
    const generation = this.generation;
    const output = await this.brain.handle({
      message,
      intent,
      signal,
      session: this.snapshot(session),
      currentTask: session.lastTaskId ? this.scheduler.get(session.lastTaskId) : undefined,
    });
    if (signal?.aborted || generation !== this.generation) return;
    if (output.kind === 'task' && !this.allowed(message.player, { kind: 'task', goal: output.task.goal ?? '' })) { this.respond(message.player, '只有 owner 能执行任务。'); return; }
    switch (output.kind) {
      case 'reply':
        this.respond(message.player, output.text);
        return;
      case 'clarify':
        this.setPending(session, { kind: 'clarify', question: output.question });
        this.respond(message.player, output.question);
        return;
      case 'task':
        if (output.confirmation) {
          this.setPending(session, { kind: 'confirm', prompt: output.confirmation, task: output.task });
          this.respond(message.player, output.confirmation);
          return;
        }
        this.submitTask(output.task, message.player, output.ack);
        return;
    }
  }

  private async handleAction(intent: ActionIntent, message: PlayerMessage, session: SessionState): Promise<void> {
    if (!this.actionResolver) {
      this.respond(message.player, '这个动作还需要目标解析，暂时做不到。');
      return;
    }
    const resolved = await this.actionResolver.resolve({
      message,
      intent,
      session: this.snapshot(session),
    });
    if (resolved.kind === 'clarify') {
      this.setPending(session, { kind: 'clarify', question: resolved.question });
      this.respond(message.player, resolved.question);
      return;
    }
    if (resolved.kind === 'blocked') {
      this.respond(message.player, resolved.reason);
      return;
    }
    const task: Task = {
      id: `action-${message.id}`,
      goal: intent.command,
      priority: 20,
      steps: [{ id: 'action', actions: resolved.actions }],
      metadata: { owner: message.player, replyTo: message.player, interaction: 'action' },
    };
    this.submitTask(task, message.player, '收到，开始执行。');
  }

  private cancelPlanning(): void {
    this.generation++;
    this.planning?.controller.abort();
    this.planning = undefined;
  }

  private submitTask(task: Task, player: string, ack = '收到，开始执行。'): void {
    const owned: Task = {
      ...task,
      metadata: { ...(task.metadata ?? {}), owner: player, replyTo: player },
    };
    try {
      this.scheduler.submit(owned);
    } catch (error) {
      this.respond(player, `任务没有提交：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const session = this.session(player, Date.now());
    session.lastTaskId = owned.id;
    session.lastTaskOwner = player;
    this.respond(player, ack);
    if (this.config.autoRun) {
      const run = this.scheduler.runUntilIdle?.();
      if (run) {
        void run.then(() => {
          const snapshot = this.scheduler.get(owned.id);
          if (snapshot && ['completed', 'failed', 'blocked', 'cancelled'].includes(snapshot.state)) {
            this.respond(player, this.resultText(snapshot));
          }
        }).catch(error => this.respond(player, `执行失败：${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  private resultText(task: TaskSnapshot): string {
    const error = task.lastResult?.error?.message;
    if (task.state === 'completed') return `完成：${task.id}。`;
    if (task.state === 'cancelled') return `任务 ${task.id} 已取消。`;
    return `任务 ${task.id} 结束：${task.state}${error ? `（${error}）` : ''}。`;
  }

  private statusText(session: SessionState): string {
    if (!session.lastTaskId) return '当前没有任务。';
    const task = this.scheduler.get(session.lastTaskId);
    if (!task) return '当前任务记录已不存在。';
    const step = Math.min(task.currentStep + 1, task.totalSteps);
    return `任务 ${task.id}：${task.state}，当前步骤 ${step}/${task.totalSteps}。`;
  }

  private isDuplicate(message: PlayerMessage, now: number): boolean {
    const key = `${message.player}:${message.id}`;
    const previous = this.seen.get(key);
    if (previous !== undefined && now - previous < 10_000) return true;
    this.seen.set(key, now);
    if (this.seen.size > 1000) {
      for (const [id, at] of this.seen) if (now - at > 60_000) this.seen.delete(id);
    }
    return false;
  }

  private allowRate(player: string, now: number): boolean {
    const { windowMs, max } = this.config.rateLimit;
    const recent = (this.rates.get(player) ?? []).filter(at => now - at < windowMs);
    if (recent.length >= max) {
      this.rates.set(player, recent);
      return false;
    }
    recent.push(now);
    this.rates.set(player, recent);
    return true;
  }

  private isOwner(player: string): boolean {
    return this.config.owners.length === 0
      || this.config.owners.some(name => name.toLowerCase() === player.toLowerCase());
  }

  private canStop(player: string, session: SessionState): boolean {
    return this.isOwner(player) || session.lastTaskOwner === player;
  }

  private allowed(player: string, intent: Intent): boolean {
    if (this.isOwner(player)) return true;
    if (!this.config.allowGuests) return false;
    return intent.kind === 'chat' || intent.kind === 'direct.reply' || intent.kind === 'query' || intent.kind === 'clarify' || (intent.kind === 'skill' && intent.skill === 'report_inventory');
  }

  private session(player: string, now: number): SessionState {
    let session = this.sessions.get(player);
    if (!session) {
      session = { player, recent: [], lastMessageAt: now };
      this.sessions.set(player, session);
    }
    return session;
  }

  private snapshot(session: SessionState): SessionSnapshot {
    return {
      player: session.player,
      lastTaskId: session.lastTaskId,
      lastIntent: session.lastIntent,
      pending: session.pending,
      recent: [...session.recent],
    };
  }

  private remember(session: SessionState, role: 'player' | 'agent', text: string, now: number): void {
    session.recent.push({ role, text, at: now });
    if (session.recent.length > 12) session.recent.shift();
  }

  private setPending(session: SessionState, pending: PendingInput): void {
    const now = Date.now();
    session.pending = { ...pending, createdAt: now, expiresAt: now + this.config.pendingTtlMs };
  }

  private clearPending(session: SessionState): void {
    session.pending = undefined;
  }

  private respond(player: string, text: string): void {
    try {
      this.transport.send(player, text);
    } catch {
      // Delivery is best-effort; it must not break the interaction loop.
    }
    const session = this.session(player, Date.now());
    this.remember(session, 'agent', text, Date.now());
  }
}
