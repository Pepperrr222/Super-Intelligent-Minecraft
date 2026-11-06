import { randomUUID } from 'node:crypto';
import type { LlmClient, LlmRequest } from './llm.js';
import type { BrainInput, BrainOutput, BrainPort } from './interaction.js';
import type { QueryOutcome, Task } from './task.js';
import { SkillCatalog, type SkillCompileContext } from './skills.js';
import { PlanValidator } from './planner.js';
import { buildBrainContext, contextBytes } from './brain-context.js';
import { DecisionValidator, DECISION_SYSTEM_PROMPT, parseDecision, REJECTION_TEXT } from './brain-decision.js';
import type { DecisionOutcome, DecisionPort, DecisionRequest } from './brain-contract.js';
import type { DiagnosticBus } from './diagnostics.js';

export interface BrainObservationPort { query(input: unknown): QueryOutcome }
export type CompanionBrainOptions = {
  diagnostics?: DiagnosticBus;
  navigateRange?: number;
  followDurationMs?: number;
  llm?: LlmClient;
  fastLlm?: LlmClient;
  plannerLlm?: LlmClient;
  fastTimeoutMs?: number;
  decisionTimeoutMs?: number;
  decisionMaxTokens?: number;
  maxPlanSteps?: number;
  maxPlanSeconds?: number;
  maxReplyChars?: number;
  contextMaxBytes?: number;
  capabilities?: readonly string[];
};
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
const PLANNER = `Return only JSON: {"kind":"plan","plan":{"id":"...","goalId":"...","revision":0,"nodes":[{"id":"n1","skill":"navigate_to","params":{"x":2,"y":64,"z":2},"preconditions":[],"postconditions":[],"idempotent":true}],"edges":[],"milestones":[],"assumptions":[],"budget":{"maxSteps":4,"maxSeconds":60}}} or {"kind":"clarify","question":"..."}. Only registered skills are available: follow_player {}, come_to_player {}, navigate_to {x,y,z}, report_inventory {}, find_resource {names,radius,limit}, gather_wood {woodType?,count,searchRadius}, collect_drops {item?,count,radius}, craft_item {item,count,table?}, store_items {container:{x,y,z},item,count}, deliver_to_player {item,count,player?}. Never invent positions; navigate_to coordinates and store_items container coordinates must appear in the goal; craft_item table coordinates and deliver_to_player player names must appear in the goal when provided. You cannot build; use craft_item only when the plan supplies or gathers the materials. Never output actions.`;
const CHAT = `You are a concise Minecraft companion. Return only JSON {"kind":"reply","text":"..."} or {"kind":"clarify","question":"..."}. Never claim actions or observations you do not know.`;
export class CompanionBrain implements BrainPort, DecisionPort {
  private readonly catalog = new SkillCatalog();
  private readonly validator = new PlanValidator(this.catalog);
  private readonly decisions = new DecisionValidator();
  constructor(private readonly observations: BrainObservationPort, private readonly options: CompanionBrainOptions = {}) {}
  async handle(input: BrainInput): Promise<BrainOutput> {
    const intent = input.intent;
    if (intent.kind === 'skill') return this.skill(intent.skill, intent.params, input);
    if (intent.kind === 'task' || intent.kind === 'plan') return this.plan(intent.goal, input);
    if (intent.kind === 'query') {
      if (intent.scope === 'inventory') return this.skill('report_inventory', intent.filter ? { filter: intent.filter } : {}, input);
      if (intent.scope === 'position') {
        const snapshot = this.snapshot() as (SkillCompileContext['snapshot'] & { position?: { x: number; y: number; z: number } }) | undefined;
        const p = snapshot?.position;
        return { kind: 'reply', text: p ? `我在 ${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}。` : '我现在看不到自己的位置。' };
      }
      return this.chat(intent.question, input);
    }
    if (intent.kind === 'chat') return this.chat(intent.text, input);
    return { kind: 'clarify', question: '这个请求应该由交互层处理。' };
  }
  /**
   * Query versioned knowledge within one time/byte budget, then validate the
   * final decision. Query turns never submit actions or create new goals.
   */
  async decide(input: DecisionRequest): Promise<DecisionOutcome> {
    const llm = this.options.plannerLlm ?? this.options.llm;
    if (!llm) return { kind: 'clarify', question: '决策模型未配置。' };

    const raw = this.observations.query({ type: 'snapshot', radius: 16 });
    const snapshot = raw.status === 'succeeded' ? raw.data : undefined;
    const context = buildBrainContext({
      trigger: input.trigger,
      player: input.player,
      session: input.session,
      ...(input.message ? { message: input.message } : {}),
      ...(input.currentTask ? { currentTask: input.currentTask } : {}),
      ...(input.lastRun ? { lastRun: input.lastRun } : {}),
      ...(snapshot !== undefined ? { snapshot } : {}),
    }, {
      ...(this.options.maxPlanSteps !== undefined ? { maxPlanSteps: this.options.maxPlanSteps } : {}),
      ...(this.options.maxPlanSeconds !== undefined ? { maxPlanSeconds: this.options.maxPlanSeconds } : {}),
      ...(this.options.maxReplyChars !== undefined ? { maxReplyChars: this.options.maxReplyChars } : {}),
      ...(this.options.contextMaxBytes !== undefined ? { maxContextBytes: this.options.contextMaxBytes } : {}),
      ...(this.options.capabilities ? { capabilities: this.options.capabilities } : {}),
    });

    // Grounding is player-authored text plus an already-confirmed goal; the
    // model's fresh plan.goal is never used to justify coordinates or names.
    const grounding = [
      input.message?.text,
      input.session.lastGoal,
      input.currentTask?.goal,
    ].filter((value): value is string => Boolean(value)).join('\n');

    const knowledge: Array<{ query: unknown; result: unknown }> = [];
    const queried = new Set<string>();
    let knowledgeTruncated = false;
    const maxBytes = this.options.contextMaxBytes ?? 12 * 1024;
    const deadline = Date.now() + (this.options.decisionTimeoutMs ?? 12_000);
    for (let turn = 0; turn <= 3; turn++) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error('LLM_CANCELLED');
      const payload = { ...context, ...(knowledge.length ? { knowledge, knowledgeTruncated } : {}) };
      if (contextBytes(payload) > maxBytes) return { kind: 'reply', text: '查询上下文超过预算，请缩小查询范围。' };
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('LLM_TIMEOUT');
      const callStarted = Date.now();
      this.options.diagnostics?.emit('model', 'start', '模型输入', { turn, context: payload });
      let text: string;
      try { text = await boundedComplete(llm, {
        system: DECISION_SYSTEM_PROMPT,
        user: JSON.stringify(payload),
        maxTokens: this.options.decisionMaxTokens ?? 900,
        temperature: 0.1,
        ...(input.signal ? { signal: input.signal } : {}),
      }, remaining); } catch (error) {
        this.options.diagnostics?.emit('model', 'error', '模型调用失败', error, Date.now() - callStarted); throw error;
      }
      this.options.diagnostics?.emit('model', 'ok', '模型原始返回（已脱敏）', { text }, Date.now() - callStarted);

      const parsed = parseDecision(text);
      if (!parsed.ok) { this.options.diagnostics?.emit('validation', 'error', '模型输出解析失败', parsed); return { kind: 'reply', text: REJECTION_TEXT[parsed.code] }; }
      this.options.diagnostics?.emit('validation', 'info', '解析后的决定（需核对意图）', parsed.decision);
      if (input.signal?.aborted) throw input.signal.reason ?? new Error('LLM_CANCELLED');
      const result = this.decisions.compile(parsed.decision, {
        player: input.player.name,
        isOwner: input.player.isOwner,
        session: input.session,
        observation: context.observation,
        availableSkills: context.availableSkills,
        availableOperations: context.availableOperations,
        grounding,
        limits: context.limits,
        ...(input.currentTask ? { currentTask: input.currentTask } : {}),
        ...(input.blockedCalls?.length ? { blockedCalls: input.blockedCalls } : {}),
        ...(snapshot !== undefined ? { compileSnapshot: snapshot as SkillCompileContext['snapshot'] } : {}),
        ...(this.options.followDurationMs !== undefined ? { followDurationMs: this.options.followDurationMs } : {}),
        ...(this.options.navigateRange !== undefined ? { navigateRange: this.options.navigateRange } : {}),
      });
      this.options.diagnostics?.emit('validation', result.kind === 'reject' ? 'blocked' : 'ok', result.kind === 'reject' ? '程序拒绝决定' : '结构与权限校验通过（不等于语义正确）', result);
      if (result.kind === 'query') {
        if (turn === 3) return { kind: 'reply', text: '本轮知识查询已达到上限，请根据已有结果缩小目标。' };
        const key = JSON.stringify(result.query);
        if (queried.has(key)) return { kind: 'reply', text: '本轮查询重复且没有新信息，请调整查询或目标。' };
        queried.add(key);
        const outcome = this.observations.query(result.query);
        if (input.signal?.aborted) throw input.signal.reason ?? new Error('LLM_CANCELLED');
        const code = typeof outcome.error === 'string' ? outcome.error.match(/^(UNKNOWN_OPERATION|UNKNOWN_BLOCK|UNKNOWN_ITEM|STALE_RECIPE|UNSUPPORTED_RECIPE|REQUIREMENT_QUANTITY_LIMIT):/u)?.[1] : undefined;
        const safe = outcome.status === 'succeeded' ? { status: 'succeeded', data: outcome.data }
          : { status: 'failed', error: code ?? 'KNOWLEDGE_QUERY_FAILED' };
        const entry = { query: result.query, result: safe };
        const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
        // Preserve structured results/references; reject an oversized page intact.
        knowledge.push(bytes <= Math.min(6000, maxBytes - contextBytes(context) - 300)
          ? entry : { query: result.query, result: { status: 'failed', error: 'OUTPUT_TOO_LARGE',
            instruction: '缩小 limit/maxNodes 或分页查询' } });
        while (knowledge.length > 1 && contextBytes({ ...context, knowledge, knowledgeTruncated }) > maxBytes) {
          knowledge.shift(); knowledgeTruncated = true;
        }
        continue;
      }
      return result.kind === 'reject' ? { kind: 'reply', text: result.message } : result;
    }
    return { kind: 'reply', text: '本轮决策达到预算，未提交操作。' };
  }
  private skill(id: string, params: unknown, input: BrainInput): BrainOutput {
    const result = this.catalog.compile(id, params, this.context(input));
    if (result.kind === 'dynamic') {
      const definition = this.catalog.get(id)!;
      const task: Task = { id:`skill-${randomUUID()}`, goal:id, priority:10, deadline:Date.now()+180_000,
        steps:[{id,actions:[],skill:result.skill,idempotent:definition.idempotent}],metadata:{source:'skill',owner:input.message.player} };
      return {kind:'task',task,ack:result.ack};
    }
    if (result.kind !== 'actions') return result;
    const skill = this.catalog.get(id)!;
    const task: Task = { id: `skill-${randomUUID()}`, goal: id, priority: 10, steps: [{ id, actions: result.actions, preconditions: skill.preconditions, postconditions: skill.postconditions, idempotent: skill.idempotent }], metadata: { source: 'skill', owner: input.message.player } };
    return { kind: 'task', task, ack: result.ack };
  }
  private async plan(goal: string, input: BrainInput): Promise<BrainOutput> {
    const llm = this.options.plannerLlm ?? this.options.llm;
    if (!llm) return { kind: 'clarify', question: '复杂任务规划还没实现。请描述一个已支持的目标。' };
    try {
      const parsed = parseJsonObject(await boundedComplete(llm, { system: PLANNER, user: JSON.stringify({ goal, player: input.message.player, observation: this.snapshot(), currentTask: input.currentTask }), maxTokens: 900, temperature: 0.1, signal: input.signal }, 15000));
      if (parsed?.kind === 'clarify' && typeof parsed.question === 'string') return { kind: 'clarify', question: parsed.question };
      if (parsed?.kind !== 'plan') return { kind: 'clarify', question: '计划格式无效，请重新描述目标。' };
      const result = this.validator.compile(parsed.plan, this.context(input), goal);
      if ('error' in result) return { kind: 'clarify', question: `计划未通过校验：${result.error}` };
      return { kind: 'task', ...result, ack: '计划已通过校验，开始执行。' };
    } catch { return { kind: 'clarify', question: '规划暂时不可用，请稍后重试或换个简单目标。' }; }
  }
  private async chat(text: string, input: BrainInput): Promise<BrainOutput> {
    const llm = this.options.fastLlm ?? this.options.llm;
    if (llm) try {
      const parsed = parseJsonObject(await boundedComplete(llm, { system: CHAT, user: JSON.stringify({ message: text, recent: input.session.recent.slice(-8), currentTask: input.currentTask ? { state: input.currentTask.state, currentStep: input.currentTask.currentStep, totalSteps: input.currentTask.totalSteps } : null }), maxTokens: 250, temperature: 0.3, signal: input.signal }, this.options.fastTimeoutMs ?? 1800));
      if (parsed?.kind === 'reply' && typeof parsed.text === 'string' && parsed.text.trim()) return { kind: 'reply', text: parsed.text };
      if (parsed?.kind === 'clarify' && typeof parsed.question === 'string' && parsed.question.trim()) return { kind: 'clarify', question: parsed.question };
    } catch { /* deterministic fallback */ }
    return { kind: 'reply', text: '我目前会跟随、过来、坐标导航和查背包。' };
  }
  private snapshot(): SkillCompileContext['snapshot'] | undefined {
    const result = this.observations.query({ type: 'snapshot', radius: 16 });
    return result.status === 'succeeded' ? result.data as SkillCompileContext['snapshot'] : undefined;
  }
  private context(input: BrainInput): SkillCompileContext { return { player: input.message.player, snapshot: this.snapshot(), followDurationMs: this.options.followDurationMs, navigateRange: this.options.navigateRange }; }
}
