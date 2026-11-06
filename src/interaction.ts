import type { DiagnosticBus } from './diagnostics.js';

import { SkillCatalog, inventoryFilterSchema, type InventoryFilter } from './skills.js';
import { boundedComplete, parseJsonObject } from './brain.js';
import { callKey, buildRunFeedback, describeFeedback, failureEntries, itemLabel } from './brain-feedback.js';
import { GoalManager, type GoalStatus } from './goals.js';
import type { DecisionOutcome, DecisionPort, DecisionRequest, RunFeedbackV1 } from './brain-contract.js';
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
  | { kind: 'query'; question: string; scope?: 'inventory' | 'position' | 'world' | 'task' | 'status' | 'help'; filter?: InventoryFilter }
  | ActionIntent
  | { kind: 'task' | 'plan'; goal: string; constraints?: string[] }
  | { kind: 'skill'; skill: string; params: unknown }
  | { kind: 'chat' | 'direct.reply'; text: string }
  | { kind: 'confirm' | 'reject' }
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
  lastGoal?: string;
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
  /** Allow one model follow-up turn after a terminal task result. */
  decisionFollowUp: boolean;
};

export const DEFAULT_INTERACTION_CONFIG: InteractionConfig = {
  owners: [],
  allowGuests: true,
  maxMessageLength: 300,
  rateLimit: { windowMs: 10_000, max: 8 },
  pendingTtlMs: 120_000,
  autoRun: true,
  decisionFollowUp: true,
};

type SessionState = {
  player: string;
  lastTaskId?: string;
  lastTaskOwner?: string;
  lastIntent?: Intent;
  lastGoal?: string;
  lastRun?: RunFeedbackV1;
  pending?: PendingInteraction;
  recent: Array<{ role: 'player' | 'agent'; text: string; at: number }>;
  lastMessageAt: number;
};

const STOP = /^(停|停下|停下来|停止|别动|别走了|stop|halt)/i;
const PAUSE = /^(暂停|先停一下|等一下|等等|pause)(吧|啊|!|！|。|\.|\s)*$/i;
const RESUME = /^(继续|接着做|恢复|resume)(吧|啊|!|！|。|\.|\s)*$/i;
const CANCEL = /^(取消|取消任务|不做了|别做了|cancel)(吧|啊|!|！|。|\.|\s)*$/i;

export function isStopCommand(text: string): boolean {
  return STOP.test(text.trim());
}

function safetyIntent(text: string): Intent | undefined {
  if (STOP.test(text)) return { kind: 'control.stop' };
  if (PAUSE.test(text)) return { kind: 'control.pause' };
  if (RESUME.test(text)) return { kind: 'control.resume' };
  if (CANCEL.test(text)) return { kind: 'control.cancel' };
  return undefined;
}

function groundedPosition(text: string, position: { x: number; y: number; z: number }): boolean {
  const numbers = text.match(/-?\d+/gu)?.map(Number) ?? [];
  return numbers.some((_, i) => numbers[i] === position.x && numbers[i + 1] === position.y && numbers[i + 2] === position.z);
}

const INTENT_SYSTEM = `You are the intent classifier for a Minecraft companion.
Return only one JSON object, with no Markdown or explanation. Allowed shapes:
{"kind":"skill","skill":"follow_player|come_to_player|navigate_to|report_inventory|find_resource|gather_wood|collect_drops|craft_item|store_items|deliver_to_player","params":{}}
{"kind":"plan","goal":"..."}
{"kind":"query","scope":"inventory|position|world|task|status|help","filter":"food|tools|blocks|armor|weapons|all","question":"..."}
{"kind":"reply","text":"..."}
{"kind":"confirm"}
{"kind":"reject"}
{"kind":"clarify","question":"..."}
Rules:
- Use a skill for a concrete request. follow_player and come_to_player take no params. navigate_to needs integer x, y and z that appear in the player's message; never invent coordinates. report_inventory may take {"filter":"food|tools|blocks|armor|weapons|all"}. find_resource only observes nearby blocks and returns candidates: params {"names":["oak_log"],"radius":16,"limit":8}, with block names joined by "_". gather_wood gathers nearby logs: params {"woodType":"oak_log","count":1,"searchRadius":16}; woodType is optional and must be a supported log name; requests such as 砍树 or chop wood are gather_wood. collect_drops picks up nearby drops: {"item":"oak_log","count":1,"radius":8}; item and count may be omitted. craft_item crafts a target count: {"item":"oak_planks","count":4,"table":{"x":0,"y":64,"z":0}}; table is optional and its coordinates must appear in the message when provided. store_items needs a chest position and item/count: {"container":{"x":0,"y":64,"z":0},"item":"oak_log","count":16}; all three container coordinates must appear in the player's message. deliver_to_player gives items to the speaker by default: {"item":"oak_log","count":3}; include player only when another player's name appears in the message.
- For any inventory question, put the requested category in filter. Use "tools" for tools, "food" for food, "blocks" for blocks, "armor" for armor, "weapons" for weapons, and "all" when the player asks for everything. Never guess what is in the inventory.
- Use query scope position for where-are-you questions.
- Use plan only when the goal needs more than one registered skill. Registered skills are follow_player, come_to_player, navigate_to, report_inventory, find_resource, gather_wood, collect_drops, craft_item, store_items and deliver_to_player. Building is unavailable; crafting uses craft_item and still needs materials and a workbench when the recipe requires one.
- Use query for status/help questions. Use reply for ordinary conversation and never claim an action or observation you do not know.
- Use clarify when the target, player or coordinates are missing or ambiguous.
- Only when pending is a confirmation: use confirm for a clear yes and reject for a clear no. If the player changes topic instead, classify that new message normally.`;

/** Model-first routing. Only the four safety controls are handled locally. */
export class IntentRouter implements IntentClassifier {
  constructor(private readonly fastLlm?: LlmClient, private readonly timeoutMs = 1800) {}
  async classify(input: { message: PlayerMessage; session?: SessionSnapshot; currentTask?: TaskSnapshot }): Promise<IntentEnvelope> {
    const text = input.message.text.trim();
    const base = { rawText: text, confidence: 1 };
    const safety = safetyIntent(text);
    if (safety) return { ...base, intent: safety };
    if (!this.fastLlm) return { ...base, confidence: 0, intent: { kind: 'clarify', question: '语义识别模型未配置，我现在只能处理急停、暂停、继续和取消。' } };
    try {
      const parsed = parseJsonObject(await boundedComplete(this.fastLlm, {
        system: INTENT_SYSTEM,
        user: JSON.stringify({
          message: text,
          recent: input.session?.recent.slice(-8),
          pending: input.session?.pending?.kind === 'confirm' ? { kind: 'confirm', prompt: input.session.pending.prompt } : null,
          currentTask: input.currentTask ? { state: input.currentTask.state, currentStep: input.currentTask.currentStep, totalSteps: input.currentTask.totalSteps } : null,
        }),
        maxTokens: 300,
        temperature: 0.1,
      }, this.timeoutMs));
      const intent = parsed ? this.fromModel(parsed, text, input.message.player) : undefined;
      return intent
        ? { ...base, intent, confidence: 0.8 }
        : { ...base, confidence: 0, intent: { kind: 'clarify', question: '我没理解你的目标，可以换个说法吗？' } };
    } catch {
      return { ...base, confidence: 0, intent: { kind: 'clarify', question: '语义识别暂时不可用，请稍后再试；急停、暂停、继续和取消仍然可用。' } };
    }
  }
  private fromModel(parsed: Record<string, unknown>, text: string, playerName: string): Intent | undefined {
    if (parsed.kind === 'skill') {
      if (typeof parsed.skill !== 'string') return undefined;
      const skill = new SkillCatalog().get(parsed.skill);
      const params = parsed.params ?? {};
      if (!skill || !skill.params.safeParse(params).success) return { kind: 'clarify', question: '技能或参数无效，请重新描述目标。' };
      if (skill.id === 'navigate_to') {
        const p = params as { x: number; y: number; z: number };
        if (!groundedPosition(text, p)) return { kind: 'clarify', question: '请给出明确的坐标，例如“走到坐标 2 64 2”。' };
      }
      if (skill.id === 'store_items') {
        const p = params as { container: { x: number; y: number; z: number } };
        if (!groundedPosition(text, p.container)) return { kind: 'clarify', question: '请给出箱子所在坐标，例如“把原木放进坐标 2 64 2 的箱子”。' };
      }
      if (skill.id === 'craft_item') {
        const p = params as { table?: { x: number; y: number; z: number } };
        if (p.table && !groundedPosition(text, p.table)) return { kind: 'clarify', question: '请给出工作台所在坐标，或让我在附近寻找工作台。' };
      }
      if (skill.id === 'deliver_to_player') {
        const p = params as { player?: string };
        if (p.player && p.player.toLowerCase() !== playerName.toLowerCase() && !text.toLowerCase().includes(p.player.toLowerCase())) {
          return { kind: 'clarify', question: `我在消息里没有看到玩家 ${p.player}，请说明要把物品交给谁。` };
        }
      }
      return { kind: 'skill', skill: skill.id, params };
    }
    if (parsed.kind === 'plan' && typeof parsed.goal === 'string' && parsed.goal.trim()) return { kind: 'plan', goal: parsed.goal };
    if (parsed.kind === 'query' && typeof parsed.scope === 'string' && ['inventory', 'position', 'world', 'task', 'status', 'help'].includes(parsed.scope)) {
      let filter: InventoryFilter | undefined;
      if (parsed.filter !== undefined) {
        const checked = inventoryFilterSchema.safeParse(parsed.filter);
        if (!checked.success) return { kind: 'clarify', question: '背包分类无效，请说明要找食物、工具、方块、盔甲还是武器。' };
        filter = checked.data;
      }
      return { kind: 'query', scope: parsed.scope as 'inventory' | 'position' | 'world' | 'task' | 'status' | 'help', filter, question: typeof parsed.question === 'string' ? parsed.question : text };
    }
    if (parsed.kind === 'reply' && typeof parsed.text === 'string' && parsed.text.trim()) return { kind: 'direct.reply', text: parsed.text };
    if (parsed.kind === 'confirm') return { kind: 'confirm' };
    if (parsed.kind === 'reject') return { kind: 'reject' };
    if (parsed.kind === 'clarify' && typeof parsed.question === 'string' && parsed.question.trim()) return { kind: 'clarify', question: parsed.question };
    return undefined;
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
  private readonly goals = new GoalManager();
  private unsubscribe?: () => void;
  private planning?: { controller: AbortController; player: string };
  private deciding?: { controller: AbortController; player: string };
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
    private readonly decision?: DecisionPort,
    private readonly diagnostics?: DiagnosticBus,
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
      this.goals.reset();
      this.scheduler.stop('玩家停止');
      this.respond(message.player, '已停。');
      return;
    }

    const fastControl: Intent | undefined = PAUSE.test(text) ? { kind: 'control.pause' } : RESUME.test(text) ? { kind: 'control.resume' } : CANCEL.test(text) ? { kind: 'control.cancel' } : undefined;
    if (fastControl) {
      if (!this.allowed(message.player, fastControl)) { this.respond(message.player, '只有 owner 能让我执行任务或控制动作；聊天和查询可以继续。'); return; }
      if (fastControl.kind === 'control.cancel' && this.planning) { this.cancelPlanning(); this.clearPending(session); const id = session.lastTaskId; if (id) this.scheduler.cancel(id, '玩家取消'); this.respond(message.player, '已取消。'); return; }
      if (fastControl.kind === 'control.cancel') { this.cancelPlanning(); this.clearPending(session); }
      await this.route(fastControl, message, session);
      return;
    }

    if (session.pending && now >= session.pending.expiresAt) this.clearPending(session);
    // The decision loop sees pending confirm/clarify state and decides the next
    // move itself. The legacy router only gets here when no decision port exists.
    if (this.decision) {
      await this.handleDecision(message, session, sequence);
      return;
    }
    if (session.pending?.kind === 'clarify') {
      // The next message answers a clarification; classify it normally.
      this.clearPending(session);
    }
    const pendingConfirm = session.pending?.kind === 'confirm' ? session.pending : undefined;

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

    if (pendingConfirm) {
      if (envelope.intent.kind === 'confirm') {
        this.clearPending(session);
        this.submitTask(pendingConfirm.task, message.player, '好，开始。');
        return;
      }
      if (envelope.intent.kind === 'reject') {
        this.clearPending(session);
        this.respond(message.player, '好，取消。');
        return;
      }
      // A new topic supersedes the pending confirmation.
      this.clearPending(session);
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
        this.goals.reset();
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
        // An explicit cancel also discards the current goal state, so a
        // later request is not blocked by an exhausted replan budget.
        this.goals.reset();
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
      case 'confirm':
      case 'reject':
        this.respond(message.player, '现在没有待确认的任务。');
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

  /** All non-safety messages enter the decision loop here. */
  private async handleDecision(
    message: PlayerMessage,
    session: SessionState,
    sequence: number,
  ): Promise<void> {
    // Latest player message wins: abandon any in-flight decision, including a
    // model follow-up after a finished run, and invalidate follow-ups that
    // would start later for a task submitted before this turn.
    if (this.deciding) {
      this.deciding.controller.abort();
      this.deciding = undefined;
    }
    this.generation++;
    const currentTask = session.lastTaskId ? this.scheduler.get(session.lastTaskId) : undefined;
    const active = currentTask && ['queued', 'running', 'paused', 'cancelling'].includes(currentTask.state)
      ? currentTask
      : undefined;
    const blockedCalls = this.goals.blockedCalls();
    const request: DecisionRequest = {
      trigger: 'player_message',
      player: { name: message.player, isOwner: this.isOwner(message.player) },
      session: this.snapshot(session),
      message,
      ...(active ? { currentTask: active } : {}),
      ...(session.lastRun ? { lastRun: session.lastRun } : {}),
      ...(blockedCalls.length > 0 ? { blockedCalls } : {}),
    };
    const generation = this.generation;
    const outcome = await this.runDecision(request, message.player, true);
    if (!outcome || generation !== this.generation) return;
    // A successful new decision resolves or replaces the previous pending
    // clarification/confirmation; a failed call leaves it intact for a retry.
    if (session.pending) this.clearPending(session);
    await this.applyDecision(outcome, message.player, session, {
      sourceText: message.text,
      sequence,
      allowTask: true,
      allowReplace: this.isOwner(message.player),
    });
  }

  /** One bounded model call; stop aborts it and late results are discarded. */
  private async runDecision(
    request: DecisionRequest,
    player: string,
    announceFailure: boolean,
  ): Promise<DecisionOutcome | undefined> {
    const controller = new AbortController();
    this.deciding = { controller, player };
    try {
      return await this.decision!.decide({ ...request, signal: controller.signal });
    } catch (error) {
      this.diagnostics?.emit('model', controller.signal.aborted ? 'cancelled' : 'error', '决策未返回可执行结果', error);
      if (!controller.signal.aborted && announceFailure) {
        this.respond(player, '决策暂时不可用，请稍后重试；急停、暂停、继续和取消仍然可用。');
      }
      return undefined;
    } finally {
      if (this.deciding?.controller === controller) this.deciding = undefined;
    }
  }

  private async applyDecision(
    outcome: DecisionOutcome,
    player: string,
    session: SessionState,
    options: {
      sourceText: string;
      sequence: number;
      allowTask: boolean;
      allowReplace: boolean;
      denyTaskText?: string;
    },
  ): Promise<void> {
    if (outcome.clearPending) this.clearPending(session);
    this.diagnostics?.emit('dispatch', 'info', '交互层收到决定', outcome);
    switch (outcome.kind) {
      case 'reply':
        this.respond(player, outcome.text);
        return;
      case 'clarify':
        this.setPending(session, { kind: 'clarify', question: outcome.question });
        this.respond(player, outcome.question);
        return;
      case 'control': {
        const cancelled = this.scheduler.cancel(outcome.taskId, '模型结束任务');
        if (cancelled) this.goals.reset();
        this.respond(player, cancelled ? '已结束当前任务。' : '当前没有可结束的任务。');
        return;
      }
      case 'task': {
        if (!options.allowTask) {
          this.diagnostics?.emit('dispatch', 'blocked', '后续任务被程序阻止', { code: 'CONTINUATION_DENIED', reason: options.denyTaskText, proposedTask: outcome.task });
          this.respond(player, options.denyTaskText ?? '这个目标已经到达重试上限，请告诉我新目标或换一种方法。');
          return;
        }
        if (options.sequence < this.latestGoalSequence) {
          this.diagnostics?.emit('dispatch', 'cancelled', '旧决定已被新消息取代', { code: 'STALE_DECISION' }); return;
        }
        this.latestGoalSequence = options.sequence;
        const current = session.lastTaskId ? this.scheduler.get(session.lastTaskId) : undefined;
        const active = current && ['queued', 'running', 'paused', 'cancelling'].includes(current.state)
          ? current
          : undefined;
        // The model may replace only its own session's active task, only on a
        // player turn, and only when it explicitly asked to replace. A pending
        // confirmation is never stored while another task still runs.
        const replace = outcome.replaceCurrent === true
          && options.allowReplace
          && !outcome.confirmation
          && active !== undefined;
        // Occupancy is checked before a confirmation is stored: a model-proposed
        // task must not leave stale pending state while another task runs.
        if (this.hasActiveTask() && !replace) {
          this.diagnostics?.emit('dispatch', 'blocked', '已有任务占用控制流程', { code: 'TASK_OCCUPIED' });
          this.respond(player, '当前还有任务在运行；要先停止或等它结束吗？');
          return;
        }
        let stopped = false;
        if (replace) {
          // Cancel only this session's task; the scheduler's active loop picks
          // up the replacement once the cancelled step settles.
          stopped = this.scheduler.cancel(active.id, '新目标替换');
          if (this.activeTasks().some(task => task.id !== active.id)) {
            this.respond(player, '当前还有另一个任务在运行；要先停止或等它结束吗？');
            return;
          }
          this.goals.reset();
        }
        if (this.goals.active && !this.goals.canReplan()) {
          this.diagnostics?.emit('dispatch', 'blocked', '目标预算耗尽，未提交任务', { code: 'GOAL_BUDGET_EXHAUSTED' });
          this.respond(player, '这个目标已经到达重试上限，请告诉我新目标或换一种方法。');
          return;
        }
        if (outcome.confirmation) {
          this.setPending(session, {
            kind: 'confirm',
            prompt: outcome.confirmation,
            task: outcome.task,
          });
          this.respond(player, outcome.confirmation);
          return;
        }
        this.submitTask(
          outcome.task,
          player,
          stopped ? `已停止当前任务；${outcome.ack ?? '开始新的目标。'}` : outcome.ack,
          { sourceText: options.sourceText },
        );
        return;
      }
    }
  }

  /** Only decision-loop tasks build verified feedback and a bounded follow-up turn. */
  private async finishDecisionTask(
    snapshot: TaskSnapshot,
    task: Task,
    player: string,
    session: SessionState,
    sourceText: string,
    generationAtSubmit: number,
  ): Promise<void> {
    const raw = buildRunFeedback({ task, snapshot });
    this.diagnostics?.task(task.id, () => this.diagnostics?.emit('feedback', raw.verified ? 'ok' : raw.outcome === 'completed' ? 'info' : 'error',
      '本次任务验收（不是玩家总目标验收）', { taskGoal: task.goal, sourceText, feedback: raw }));
    const calls = task.steps.flatMap(step => step.skill
      ? [callKey(step.skill.id, step.skill.params)]
      : step.actions.flatMap(action => action.type === 'operate' ? [callKey('operate', action.operation)] : []));
    const feedback = this.goals.record(raw, failureEntries(task, raw), calls);
    session.lastRun = feedback;
    this.respond(player, describeFeedback(feedback));

    const terminal: GoalStatus = feedback.outcome === 'timeout' ? 'failed' : feedback.outcome;
    // A stop/cancel after submission owns the next turn; never start a model
    // follow-up for a generation the player already interrupted.
    if (generationAtSubmit !== this.generation) {
      this.goals.finish(terminal);
      return;
    }
    if (!this.config.decisionFollowUp || !this.decision) {
      this.goals.finish(terminal);
      return;
    }
    if (feedback.outcome === 'cancelled') {
      // Cancellation never resumes by itself.
      this.goals.finish('cancelled');
      return;
    }
    const completed = feedback.outcome === 'completed';
    if (!completed && (!this.goals.turn() || !this.goals.canReplan())) {
      this.goals.finish(terminal);
      return;
    }

    const blockedCalls = completed ? [] : this.goals.blockedCalls();
    const request: DecisionRequest = {
      trigger: 'run_finished',
      player: { name: player, isOwner: this.isOwner(player) },
      session: this.snapshot(session),
      lastRun: feedback,
      ...(blockedCalls.length > 0 ? { blockedCalls } : {}),
    };
    const generation = this.generation;
    const outcome = await this.runDecision(request, player, false);
    if (!outcome || generation !== this.generation) {
      // Aborted by a newer player message or stop; the new player turn owns
      // the next goal, so this one is closed.
      this.goals.finish(terminal);
      return;
    }

    const allowTask = !completed && this.goals.canReplan();
    await this.applyDecision(outcome, player, session, {
      sourceText,
      sequence: this.messageSequence,
      allowTask,
      allowReplace: false,
      ...(completed ? { denyTaskText: '这个目标已经完成；如果要继续，直接告诉我新的目标。' } : {}),
    });
    if (outcome.kind !== 'task' || !allowTask) {
      this.goals.finish(terminal);
    }
  }

  private activeTasks(): TaskSnapshot[] {
    return this.scheduler.list().filter(task =>
      ['queued', 'running', 'paused', 'cancelling'].includes(task.state));
  }

  private hasActiveTask(): boolean {
    return this.activeTasks().length > 0;
  }

  private cancelPlanning(): void {
    this.generation++;
    this.planning?.controller.abort();
    this.planning = undefined;
    this.deciding?.controller.abort();
    this.deciding = undefined;
  }

  private submitTask(
    task: Task,
    player: string,
    ack = '收到，开始执行。',
    decision?: { sourceText: string },
  ): void {
    if (decision && this.goals.active && !this.goals.canReplan()) {
      this.respond(player, '这个目标已经到达重试上限，请告诉我新目标或换一种方法。');
      return;
    }
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
    if (decision) {
      session.lastGoal = owned.goal ?? decision.sourceText;
      if (this.goals.active) this.goals.noteReplan();
      else this.goals.begin({
        owner: player,
        sourceText: decision.sourceText,
        goal: owned.goal ?? null,
      });
    }
    this.respond(player, ack);
    if (this.config.autoRun) {
      const generation = this.generation;
      const run = this.scheduler.runUntilIdle?.();
      if (run) {
        void (async () => {
          try {
            await run;
          } catch (error) {
            this.respond(player, `执行失败：${error instanceof Error ? error.message : String(error)}`);
            return;
          }
          // A replacement task may be queued behind the cancelled run and be
          // executed by that run's loop; wait for this task itself to settle.
          const snapshot = await this.awaitTerminal(owned);
          if (!snapshot) return;
          // A stopped or replaced task may settle after a newer task became the
          // session's current one; its result must not overwrite the new goal.
          if (session.lastTaskId !== owned.id) return;
          if (decision) {
            await this.finishDecisionTask(snapshot, owned, player, session, decision.sourceText, generation);
            return;
          }
          this.respond(player, this.resultText(snapshot));
        })().catch(error => this.respond(player, `执行失败：${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  /** Wait (bounded) until the submitted task reaches a terminal state. */
  private async awaitTerminal(task: Task): Promise<TaskSnapshot | undefined> {
    const terminal = new Set(['completed', 'failed', 'blocked', 'cancelled']);
    const deadline = task.deadline !== undefined
      ? Math.max(Date.now() + 5_000, task.deadline + 5_000)
      : Date.now() + 300_000;
    for (;;) {
      const snapshot = this.scheduler.get(task.id);
      if (!snapshot || terminal.has(snapshot.state)) return snapshot;
      if (Date.now() >= deadline) return undefined;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  private resultText(task: TaskSnapshot): string {
    const error = task.lastResult?.error?.message;
    const progress = task.lastResult?.data as {collected?:number;requested?:number;woodType?:string|null}|undefined;
    if (typeof progress?.collected==='number' && typeof progress.requested==='number') {
      const label = itemLabel(progress.woodType ?? 'oak_log');
      return task.state==='completed'
        ? `采集完成：获得 ${progress.collected} 个 ${label}。`
        : `采集${task.state==='cancelled'?'已停止':'未完成'}：获得 ${progress.collected}/${progress.requested} 个 ${label}${error ? `（${error}）` : ''}。`;
    }
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
      lastGoal: session.lastGoal,
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
