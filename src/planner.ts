import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { conditionSchema } from './schema.js';
import { SkillCatalog, type SkillContext } from './skills.js';
import type { Task, TaskStep } from './task.js';

const planSchema = z.object({
  id: z.string().min(1).max(100), goalId: z.string().min(1).max(100), revision: z.number().int().nonnegative(),
  nodes: z.array(z.object({ id: z.string().min(1).max(100), skill: z.string(), params: z.unknown(), preconditions: z.array(conditionSchema).max(10), postconditions: z.array(conditionSchema).max(10), idempotent: z.boolean() }).strict()).min(1).max(12),
  edges: z.array(z.object({ from: z.string(), to: z.string() }).strict()).max(40),
  milestones: z.array(z.string().max(200)).max(12), assumptions: z.array(z.string().max(200)).max(12),
  budget: z.object({ maxSteps: z.number().int().min(1).max(12), maxSeconds: z.number().int().min(1).max(300) }).strict(),
}).strict();
export type Plan = z.infer<typeof planSchema>;
export class PlanValidator {
  constructor(private readonly catalog = new SkillCatalog()) {}
  compile(value: unknown, context: SkillContext, goal: string): { task: Task; confirmation?: string } | { error: string } {
    const parsed = planSchema.safeParse(value);
    if (!parsed.success) return { error: '计划格式或预算无效。' };
    const plan = parsed.data;
    if (plan.nodes.length > plan.budget.maxSteps) return { error: '计划超过步骤预算。' };
    const nodes = new Map(plan.nodes.map(n => [n.id, n]));
    if (nodes.size !== plan.nodes.length) return { error: '计划节点编号重复。' };
    const incoming = new Map(plan.nodes.map(n => [n.id, 0]));
    const outgoing = new Map(plan.nodes.map(n => [n.id, [] as string[]]));
    const edges = new Set<string>();
    for (const edge of plan.edges) {
      const key = JSON.stringify([edge.from, edge.to]);
      if (!nodes.has(edge.from) || !nodes.has(edge.to) || edges.has(key)) return { error: '计划依赖无效。' };
      edges.add(key); incoming.set(edge.to, incoming.get(edge.to)! + 1); outgoing.get(edge.from)!.push(edge.to);
    }
    const queue = plan.nodes.filter(n => incoming.get(n.id) === 0).map(n => n.id);
    const order: string[] = [];
    while (queue.length) { const id = queue.shift()!; order.push(id); for (const next of outgoing.get(id)!) { incoming.set(next, incoming.get(next)! - 1); if (incoming.get(next) === 0) queue.push(next); } }
    if (order.length !== nodes.size) return { error: '计划依赖存在环。' };
    const steps: TaskStep[] = []; let confirm = plan.nodes.length > 1; let durationMs = 0;
    for (const id of order) {
      const node = nodes.get(id)!; const skill = this.catalog.get(node.skill);
      if (!skill || node.idempotent && !skill.idempotent) return { error: '计划引用未知技能或无效的幂等声明。' };
      if (node.skill === 'navigate_to') {
        const p = node.params as { x?: unknown; y?: unknown; z?: unknown };
        const coordinates = goal.match(/-?\d+/gu)?.map(Number) ?? [];
        const specified = coordinates.some((_, i) => coordinates[i] === p?.x && coordinates[i + 1] === p?.y && coordinates[i + 2] === p?.z);
        const observed = context.snapshot?.entities?.some(e => e.position && Math.floor(e.position.x) === p?.x && Math.floor(e.position.y) === p?.y && Math.floor(e.position.z) === p?.z);
        if (!specified && !observed) return { error: '计划包含没有依据的坐标。' };
      }
      const result = this.catalog.compile(node.skill, node.params, context);
      if (result.kind !== 'actions') return { error: result.kind === 'clarify' ? result.question : '查询技能不能作为计划动作。' };
      durationMs += result.actions.reduce((sum, action) => sum + ('durationMs' in action ? action.durationMs : 0), 0);
      confirm ||= skill.risk !== 'safe';
      steps.push({ id, actions: result.actions, preconditions: [...skill.preconditions, ...node.preconditions], postconditions: [...skill.postconditions, ...node.postconditions], idempotent: skill.idempotent && node.idempotent });
    }
    if (durationMs > plan.budget.maxSeconds * 1000) return { error: '计划超过时间预算。' };
    return { task: { id: `plan-${randomUUID()}`, goal, priority: 10, deadline: Date.now() + plan.budget.maxSeconds * 1000, steps, metadata: { planId: plan.id, goalId: plan.goalId, revision: plan.revision, assumptions: plan.assumptions } }, ...(confirm ? { confirmation: '这个计划包含多步或需确认的动作，要开始吗？' } : {}) };
  }
}
