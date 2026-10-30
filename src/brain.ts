import { randomUUID } from 'node:crypto';
import type { LlmClient, LlmRequest } from './llm.js';
import type { BrainInput, BrainOutput, BrainPort } from './interaction.js';
import type { QueryOutcome, Task } from './task.js';
import { SkillCatalog, type SkillContext } from './skills.js';
import { PlanValidator } from './planner.js';

export interface BrainObservationPort { query(input: unknown): QueryOutcome }
export type CompanionBrainOptions = { navigateRange?: number; followDurationMs?: number; llm?: LlmClient; fastLlm?: LlmClient; plannerLlm?: LlmClient; fastTimeoutMs?: number };
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try { const cleaned = text.trim().replace(/^```(?:json)?/iu, '').replace(/```$/u, '').trim(); const obj: unknown = JSON.parse(cleaned); return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj as Record<string, unknown> : undefined; } catch { return undefined; }
}
export async function boundedComplete(client: LlmClient, request: LlmRequest, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal?.reason);
  if (request.signal?.aborted) abort(); else request.signal?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.complete({ ...request, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        const fail = () => reject(new Error('LLM_CANCELLED'));
        if (controller.signal.aborted) fail(); else controller.signal.addEventListener('abort', fail, { once: true });
        timer = setTimeout(() => controller.abort(), timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); request.signal?.removeEventListener('abort', abort); }
}
const PLANNER = `Return only JSON: {"kind":"plan","plan":{"id":"...","goalId":"...","revision":0,"nodes":[{"id":"n1","skill":"navigate_to","params":{"x":2,"y":64,"z":2},"preconditions":[],"postconditions":[],"idempotent":true}],"edges":[],"milestones":[],"assumptions":[],"budget":{"maxSteps":4,"maxSeconds":60}}} or {"kind":"clarify","question":"..."}. Only registered skills are available: follow_player {}, come_to_player {}, navigate_to {x,y,z}. Never invent positions. You cannot build, collect or craft; clarify when those skills are needed. Never output actions.`;
const CHAT = `You are a concise Minecraft companion. Return only JSON {"kind":"reply","text":"..."} or {"kind":"clarify","question":"..."}. Never claim actions or observations you do not know.`;
export class CompanionBrain implements BrainPort {
  private readonly catalog = new SkillCatalog();
  private readonly validator = new PlanValidator(this.catalog);
  constructor(private readonly observations: BrainObservationPort, private readonly options: CompanionBrainOptions = {}) {}
  async handle(input: BrainInput): Promise<BrainOutput> {
    const intent = input.intent;
    if (intent.kind === 'skill') return this.skill(intent.skill, intent.params, input);
    if (intent.kind === 'task' || intent.kind === 'plan') {
      const match = this.catalog.match(intent.goal);
      return match ? this.skill(match.id, match.params, input) : this.plan(intent.goal, input);
    }
    if (intent.kind === 'query') {
      if (intent.scope === 'inventory') return this.skill('report_inventory', {}, input);
      if (/(在哪|位置|坐标)/u.test(intent.question)) {
        const snapshot = this.snapshot() as (SkillContext['snapshot'] & { position?: { x: number; y: number; z: number } }) | undefined;
        const p = snapshot?.position;
        return { kind: 'reply', text: p ? `我在 ${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}。` : '我现在看不到自己的位置。' };
      }
      return this.chat(intent.question, input);
    }
    if (intent.kind === 'chat') return this.chat(intent.text, input);
    return { kind: 'clarify', question: '这个请求应该由交互层处理。' };
  }
  private skill(id: string, params: unknown, input: BrainInput): BrainOutput {
    const result = this.catalog.compile(id, params, this.context(input));
    if (result.kind !== 'actions') return result;
    const skill = this.catalog.get(id)!;
    const task: Task = { id: `skill-${randomUUID()}`, goal: id, priority: 10, steps: [{ id, actions: result.actions, preconditions: skill.preconditions, postconditions: skill.postconditions, idempotent: skill.idempotent }], metadata: { source: 'skill', owner: input.message.player } };
    return { kind: 'task', task, ack: result.ack, ...(skill.risk !== 'safe' ? { confirmation: '要执行这个技能吗？' } : {}) };
  }
  private async plan(goal: string, input: BrainInput): Promise<BrainOutput> {
    const llm = this.options.plannerLlm ?? this.options.llm;
    if (!llm) return { kind: 'clarify', question: '复杂任务规划还没实现。请描述一个已支持的目标。' };
    try {
      const parsed = parseJsonObject(await boundedComplete(llm, { system: PLANNER, user: JSON.stringify({ goal, player: input.message.player, observation: this.snapshot(), currentTask: input.currentTask }), maxTokens: 900, temperature: 0.1, signal: input.signal }, 15000));
      if (parsed?.kind === 'clarify' && typeof parsed.question === 'string') return { kind: 'clarify', question: parsed.question };
      if (parsed?.kind !== 'plan') return { kind: 'clarify', question: '计划格式无效，请重新描述目标。' };
      if (/(?:建|造|房子|收集|采集|挖|制作|合成|熔炼|build|construct|house|gather|collect|mine|craft|smelt)/iu.test(goal)) return { kind: 'clarify', question: '我还没有建造、采集或制作技能，暂时无法完成这个目标。' };
      const result = this.validator.compile(parsed.plan, this.context(input), goal);
      if ('error' in result) return { kind: 'clarify', question: `计划未通过校验：${result.error}` };
      return { kind: 'task', ...result, ack: '计划已通过校验，开始执行。' };
    } catch { return { kind: 'clarify', question: '规划暂时不可用，请稍后重试或换个简单目标。' }; }
  }
  private async chat(text: string, input: BrainInput): Promise<BrainOutput> {
    if (/^(你好|嗨|hello|hi)[!！。\s]*$/iu.test(text)) return { kind: 'reply', text: '你好，我在这里。' };
    const llm = this.options.fastLlm ?? this.options.llm;
    if (llm) try {
      const parsed = parseJsonObject(await boundedComplete(llm, { system: CHAT, user: JSON.stringify({ message: text, recent: input.session.recent.slice(-8), currentTask: input.currentTask ? { state: input.currentTask.state, currentStep: input.currentTask.currentStep, totalSteps: input.currentTask.totalSteps } : null }), maxTokens: 250, temperature: 0.3, signal: input.signal }, this.options.fastTimeoutMs ?? 1800));
      if (parsed?.kind === 'reply' && typeof parsed.text === 'string' && parsed.text.trim()) return { kind: 'reply', text: parsed.text };
      if (parsed?.kind === 'clarify' && typeof parsed.question === 'string' && parsed.question.trim()) return { kind: 'clarify', question: parsed.question };
    } catch { /* deterministic fallback */ }
    return { kind: 'reply', text: '我目前会跟随、过来、坐标导航和查背包。' };
  }
  private snapshot(): SkillContext['snapshot'] | undefined {
    const result = this.observations.query({ type: 'snapshot', radius: 16 });
    return result.status === 'succeeded' ? result.data as SkillContext['snapshot'] : undefined;
  }
  private context(input: BrainInput): SkillContext { return { player: input.message.player, snapshot: this.snapshot(), followDurationMs: this.options.followDurationMs, navigateRange: this.options.navigateRange }; }
}
