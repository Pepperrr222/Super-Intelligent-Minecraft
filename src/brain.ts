import { randomUUID } from 'node:crypto';
import { actionSchema, type Action } from './schema.js';
import type { LlmClient } from './llm.js';
import type {
  BrainInput,
  BrainOutput,
  BrainPort,
} from './interaction.js';
import type { QueryOutcome, Task, TaskSnapshot, TaskStep } from './task.js';

export interface BrainObservationPort {
  /** Read-only world/inventory observation. It must not take the action lease. */
  query(input: unknown): QueryOutcome;
}

export type CompanionBrainOptions = {
  navigateRange?: number;
  followDurationMs?: number;
  llm?: LlmClient;
};

type Vec3Like = { x: number; y: number; z: number };
type ObservedEntity = { id: number; username?: string; name?: string; position?: Vec3Like };
type Snapshot = {
  position?: Vec3Like;
  inventory?: Array<{ name: string; count: number }>;
  entities?: ObservedEntity[];
};
type JsonObject = Record<string, unknown>;

const PLANNER_SYSTEM = `You are the planning layer of a Minecraft companion.
Return ONLY one JSON object, with no Markdown and no explanation.
Allowed shapes:
{"kind":"task","goal":"...","ack":"...","steps":[{"id":"s1","actions":[...]}]}
{"kind":"reply","text":"..."}
{"kind":"clarify","question":"..."}

Rules:
- Use only these action types: navigate, follow, look_at, look_at_entity, dig, place, equip, select_slot, craft, container_transfer, attack_once, wait, say.
- Do not invent coordinates. Use only positions/entity ids in the supplied observation.
- Keep plans to 1-6 steps. Do not plan building, resource-gathering chains, or other long-horizon work; return clarify instead.
- A step has 1-4 actions. Do not use unsupported fields.
- Prefer navigate/follow for simple movement requests.
- Positions must be nested: {"type":"navigate","position":{"x":2,"y":64,"z":2},"range":2}
- Follow example: {"type":"follow","entityId":7,"distance":2,"durationMs":10000}
- If the request is ambiguous, unsafe, or lacks a target, return clarify.`;

const ANSWER_SYSTEM = `You are the query responder of a Minecraft companion.
Return ONLY one JSON object:
{"kind":"reply","text":"..."} or {"kind":"clarify","question":"..."}
Use only the supplied observation. Do not claim to have performed an action.
Do not invent inventory, positions, entities, task state, or success.`;

const CHAT_SYSTEM = `You are a concise Minecraft companion.
Return ONLY one JSON object: {"kind":"reply","text":"..."} or {"kind":"clarify","question":"..."}.
Do not claim to execute actions. If the player asks for a task, say that task planning is separate.`;

const SAFE_IDEMPOTENT = new Set([
  'wait', 'wait_ticks', 'look', 'look_at', 'look_at_entity', 'navigate', 'say', 'select_slot',
]);

const DESTRUCTIVE = new Set([
  'toss', 'trade', 'consume', 'enchant', 'anvil', 'container_transfer', 'attack_once', 'place',
]);

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string): JsonObject | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?/iu, '').replace(/```$/u, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAction(candidate: unknown): unknown {
  if (!isRecord(candidate)) return candidate;
  const action = { ...candidate };
  delete action.description;
  delete action.reason;
  delete action.label;
  delete action.comment;

  const hasFlatPosition = typeof action.x === 'number'
    && typeof action.y === 'number'
    && typeof action.z === 'number';
  if (hasFlatPosition) {
    const position = { x: action.x, y: action.y, z: action.z };
    if (action.type === 'place' || action.type === 'place_entity') {
      if (!isRecord(action.reference)) action.reference = position;
    } else if (!isRecord(action.position)) {
      action.position = position;
    }
    delete action.x;
    delete action.y;
    delete action.z;
  }
  return action;
}

/**
 * Brain v0 with an optional LLM planner/responder.
 * Deterministic movement commands still short-circuit; the LLM is validated
 * against actionSchema and only returns a Task for the scheduler.
 */
export class CompanionBrain implements BrainPort {
  constructor(
    private readonly observations: BrainObservationPort,
    private readonly options: CompanionBrainOptions = {},
  ) {}

  async handle(input: BrainInput): Promise<BrainOutput> {
    switch (input.intent.kind) {
      case 'task':
        return this.planTask(input.intent.goal, input);
      case 'query':
        return this.answer(input.intent.scope, input.intent.question, input);
      case 'chat':
        return this.chat(input.intent.text, input);
      default:
        return { kind: 'clarify', question: '这个请求应该由交互/调度层处理。' };
    }
  }

  private async planTask(goal: string, input: BrainInput): Promise<BrainOutput> {
    const text = goal.trim();
    if (/(过来|来这|到我|来这里)/.test(text)) return this.comeTask(input);
    if (/(跟着|跟上|跟随)/.test(text)) return this.followTask(input);

    if (this.options.llm) {
      const planned = await this.llmPlan(text, input);
      if (planned) return planned;
    }

    if (/(建|造|房子|收集|挖|做|整理|熔炼)/.test(text)) {
      return {
        kind: 'clarify',
        question: '复杂任务规划还没实现。我现在能试“过来”“跟着我”或查背包，换个目标？',
      };
    }
    return {
      kind: 'clarify',
      question: '你想让我做什么？可以试“过来”“跟着我”或“背包里有什么”。',
    };
  }

  private comeTask(input: BrainInput): BrainOutput {
    const snapshot = this.snapshot();
    if (!snapshot) return { kind: 'clarify', question: '我现在看不到世界状态，先等一下。' };
    const player = this.findPlayer(snapshot, input.message.player);
    const position = player?.position;
    if (!position) return { kind: 'clarify', question: `我看不到你（${input.message.player}）的位置，靠近一点再试。` };

    const action: Action = {
      type: 'navigate',
      position: {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z),
      },
      range: this.options.navigateRange ?? 2,
    };
    const task = this.task(input, 'come', 'approach', [action], '过来了。');
    return { kind: 'task', ...task };
  }

  private followTask(input: BrainInput): BrainOutput {
    const snapshot = this.snapshot();
    if (!snapshot) return { kind: 'clarify', question: '我现在看不到世界状态，先等一下。' };
    const player = this.findPlayer(snapshot, input.message.player);
    if (!player) return { kind: 'clarify', question: `我看不到你（${input.message.player}），靠近一点再试。` };

    const seconds = Math.round((this.options.followDurationMs ?? 30_000) / 1000);
    const action: Action = {
      type: 'follow',
      entityId: player.id,
      distance: 2,
      durationMs: this.options.followDurationMs ?? 30_000,
    };
    const task = this.task(input, 'follow', 'follow', [action], `跟着你（先跟 ${seconds} 秒）。`);
    return { kind: 'task', ...task };
  }

  private async llmPlan(text: string, input: BrainInput): Promise<BrainOutput | undefined> {
    const snapshot = this.snapshot();
    try {
      const raw = await this.options.llm!.complete({
        system: PLANNER_SYSTEM,
        user: JSON.stringify({
          player: input.message.player,
          message: text,
          observation: this.compact(snapshot),
          currentTask: this.taskSummary(input.currentTask),
        }),
        temperature: 0.1,
        maxTokens: 900,
      });
      const parsed = parseJsonObject(raw);
      if (!parsed) return undefined;

      if (parsed.kind === 'clarify' && typeof parsed.question === 'string') {
        return { kind: 'clarify', question: parsed.question };
      }
      if (parsed.kind === 'reply' && typeof parsed.text === 'string') {
        return { kind: 'reply', text: parsed.text };
      }
      if (parsed.kind !== 'task') return undefined;

      const steps = this.validateSteps(parsed.steps);
      if (!steps) {
        return { kind: 'clarify', question: '我生成的计划没有通过动作校验，换个说法？' };
      }
      const task: Task = {
        id: `brain-${randomUUID()}`,
        goal: typeof parsed.goal === 'string' ? parsed.goal : text,
        priority: 10,
        steps,
        metadata: {
          owner: input.message.player,
          replyTo: input.message.player,
          source: 'brain-llm',
        },
      };
      const confirmation = this.needsConfirmation(steps)
        ? '这个计划包含多步或不可逆动作，要开始吗？'
        : undefined;
      return {
        kind: 'task',
        task,
        ack: typeof parsed.ack === 'string' ? parsed.ack : '收到，开始执行。',
        ...(confirmation ? { confirmation } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private async answer(
    scope: 'inventory' | 'world' | 'task' | 'status' | 'help' | undefined,
    question: string,
    input: BrainInput,
  ): Promise<BrainOutput> {
    if (scope === 'inventory' || /(背包|物品|多少|带了什么)/.test(question)) {
      const snapshot = this.snapshot();
      if (!snapshot) return { kind: 'reply', text: '我现在看不到背包状态。' };
      const counts = new Map<string, number>();
      for (const item of snapshot.inventory ?? []) {
        counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
      }
      if (counts.size === 0) return { kind: 'reply', text: '背包是空的。' };
      const text = [...counts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => `${name} x${count}`)
        .join('，');
      return { kind: 'reply', text: `背包里有：${text}。` };
    }

    if (/(在哪|位置|坐标)/.test(question)) {
      const snapshot = this.snapshot();
      if (!snapshot?.position) return { kind: 'reply', text: '我现在看不到自己的位置。' };
      const { x, y, z } = snapshot.position;
      return { kind: 'reply', text: `我在 ${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)}。` };
    }

    if (this.options.llm) {
      const answered = await this.llmAnswer(question, input);
      if (answered) return answered;
    }

    const snapshot = this.snapshot();
    if (!snapshot) return { kind: 'reply', text: '我现在看不到世界状态。' };
    const items = (snapshot.inventory ?? []).reduce((sum, item) => sum + item.count, 0);
    return {
      kind: 'reply',
      text: `我看到 ${snapshot.entities?.length ?? 0} 个附近实体，背包共 ${items} 件物品。`,
    };
  }

  private async llmAnswer(question: string, input: BrainInput): Promise<BrainOutput | undefined> {
    const snapshot = this.snapshot();
    try {
      const raw = await this.options.llm!.complete({
        system: ANSWER_SYSTEM,
        user: JSON.stringify({
          player: input.message.player,
          question,
          observation: this.compact(snapshot),
          currentTask: this.taskSummary(input.currentTask),
        }),
        temperature: 0.1,
        maxTokens: 400,
      });
      const parsed = parseJsonObject(raw);
      if (parsed?.kind === 'reply' && typeof parsed.text === 'string') {
        return { kind: 'reply', text: parsed.text };
      }
      if (parsed?.kind === 'clarify' && typeof parsed.question === 'string') {
        return { kind: 'clarify', question: parsed.question };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private async chat(text: string, input: BrainInput): Promise<BrainOutput> {
    if (this.options.llm) {
      try {
        const raw = await this.options.llm.complete({
          system: CHAT_SYSTEM,
          user: JSON.stringify({
            player: input.message.player,
            message: text,
            observation: this.compact(this.snapshot()),
          }),
          temperature: 0.5,
          maxTokens: 200,
        });
        const parsed = parseJsonObject(raw);
        if (parsed?.kind === 'reply' && typeof parsed.text === 'string') {
          return { kind: 'reply', text: parsed.text };
        }
        if (parsed?.kind === 'clarify' && typeof parsed.question === 'string') {
          return { kind: 'clarify', question: parsed.question };
        }
      } catch {
        // Fall through to the deterministic reply.
      }
    }
    if (/(你好|嗨|hello|hi)/i.test(text)) return { kind: 'reply', text: '你好，我在这里。' };
    return {
      kind: 'reply',
      text: '我目前会“过来”“跟着我”和查背包；复杂任务会先要求澄清。',
    };
  }

  private validateSteps(value: unknown): TaskStep[] | undefined {
    if (!Array.isArray(value) || value.length === 0 || value.length > 6) return undefined;
    const ids = new Set<string>();
    const steps: TaskStep[] = [];
    for (const raw of value) {
      if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id.trim() || ids.has(raw.id)) return undefined;
      if (!Array.isArray(raw.actions) || raw.actions.length === 0 || raw.actions.length > 4) return undefined;
      const actions: Action[] = [];
      for (const candidate of raw.actions) {
        const parsed = actionSchema.safeParse(normalizeAction(candidate));
        if (!parsed.success) return undefined;
        actions.push(parsed.data);
      }
      ids.add(raw.id);
      steps.push({
        id: raw.id,
        actions,
        idempotent: actions.every(action => SAFE_IDEMPOTENT.has(action.type)),
      });
    }
    return steps;
  }

  private needsConfirmation(steps: TaskStep[]): boolean {
    return steps.length > 1
      || steps.some(step => step.actions.some(action => DESTRUCTIVE.has(action.type)));
  }

  private task(
    input: BrainInput,
    goal: string,
    stepId: string,
    actions: Action[],
    ack: string,
  ): { task: Task; ack: string } {
    return {
      task: {
        id: `brain-${randomUUID()}`,
        goal,
        priority: 10,
        steps: [{ id: stepId, actions, idempotent: true }],
        metadata: {
          owner: input.message.player,
          replyTo: input.message.player,
          source: 'brain-v0',
        },
      },
      ack,
    };
  }

  private compact(snapshot: Snapshot | undefined): unknown {
    if (!snapshot) return null;
    const counts = new Map<string, number>();
    for (const item of snapshot.inventory ?? []) {
      counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
    }
    return {
      position: snapshot.position,
      inventory: [...counts.entries()].map(([name, count]) => ({ name, count })),
      entities: (snapshot.entities ?? []).slice(0, 20).map(entity => ({
        id: entity.id,
        username: entity.username,
        name: entity.name,
        position: entity.position,
      })),
    };
  }

  private taskSummary(task: TaskSnapshot | undefined): unknown {
    if (!task) return null;
    return {
      id: task.id,
      state: task.state,
      currentStep: task.currentStep,
      totalSteps: task.totalSteps,
    };
  }

  private snapshot(): Snapshot | undefined {
    const result = this.observations.query({ type: 'snapshot', radius: 16 });
    if (result.status !== 'succeeded') return undefined;
    return result.data as Snapshot | undefined;
  }

  private findPlayer(snapshot: Snapshot, player: string): ObservedEntity | undefined {
    return snapshot.entities?.find(entity =>
      entity.username?.toLowerCase() === player.toLowerCase()
      || entity.name?.toLowerCase() === player.toLowerCase());
  }
}
