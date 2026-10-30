import { z, type ZodType } from 'zod';
import { actionSchema, type Action, type Condition } from './schema.js';

export type SkillContext = {
  player: string;
  snapshot?: { inventory?: Array<{ name: string; count: number }>; entities?: Array<{ id: number; username?: string; name?: string; position?: { x: number; y: number; z: number } }> };
  followDurationMs?: number;
  navigateRange?: number;
};
export type SkillResult = { kind: 'actions'; actions: Action[]; ack: string } | { kind: 'reply'; text: string } | { kind: 'clarify'; question: string };
export type Skill = {
  id: string; aliases: string[]; params: ZodType; preconditions: Condition[]; postconditions: Condition[];
  risk: 'safe' | 'confirm' | 'destructive'; idempotent: boolean;
  compile(params: any, context: SkillContext): SkillResult;
};
const empty = z.object({}).strict();
const player = (c: SkillContext) => c.snapshot?.entities?.find(e => e.username?.toLowerCase() === c.player.toLowerCase() || e.name?.toLowerCase() === c.player.toLowerCase());
const missing = (c: SkillContext): SkillResult => ({ kind: 'clarify', question: `我看不到你（${c.player}），靠近一点再试。` });
export const skills: Skill[] = [
  { id: 'follow_player', aliases: ['follow me', '跟着我', '跟上', '跟随我'], params: empty, preconditions: [], postconditions: [], risk: 'safe', idempotent: false,
    compile: (_p, c) => { const entity = player(c); return entity ? { kind: 'actions', actions: [{ type: 'follow', entityId: entity.id, distance: 2, durationMs: c.followDurationMs ?? 30000 }], ack: `跟着你（先跟 ${Math.round((c.followDurationMs ?? 30000) / 1000)} 秒）。` } : missing(c); } },
  { id: 'come_to_player', aliases: ['come here', '过来', '到我这里', '来这里', '来这'], params: empty, preconditions: [], postconditions: [], risk: 'safe', idempotent: true,
    compile: (_p, c) => { const pos = player(c)?.position; return pos ? { kind: 'actions', actions: [{ type: 'navigate', position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, range: c.navigateRange ?? 2 }], ack: '正在过去。' } : missing(c); } },
  { id: 'navigate_to', aliases: ['go to', '走到坐标'], params: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict(), preconditions: [], postconditions: [], risk: 'safe', idempotent: true,
    compile: (p, c) => ({ kind: 'actions', actions: [{ type: 'navigate', position: p, range: c.navigateRange ?? 2 }], ack: '收到，开始导航。' }) },
  { id: 'report_inventory', aliases: ['背包里有什么', '背包有什么', "what's in your inventory", 'what is in your inventory'], params: empty, preconditions: [], postconditions: [], risk: 'safe', idempotent: true,
    compile: (_p, c) => { if (!c.snapshot) return { kind: 'reply', text: '我现在看不到背包状态。' }; const counts = new Map<string, number>(); for (const item of c.snapshot.inventory ?? []) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count); return { kind: 'reply', text: counts.size ? `背包里有：${[...counts].sort(([a],[b]) => a.localeCompare(b)).map(([name,count]) => `${name} x${count}`).join('，')}。` : '背包是空的。' }; } },
];
export class SkillCatalog {
  get(id: string): Skill | undefined { return skills.find(s => s.id === id); }
  match(text: string): { id: string; params: unknown } | undefined {
    const normalized = text.trim().replace(/[!！。?？]+$/u, '').trim().toLowerCase();
    const coord = /^(?:走到(?:坐标)?|go\s+to(?:\s+coordinates?)?)\s*\(?\s*(-?\d+)\s*[,，\s]+\s*(-?\d+)\s*[,，\s]+\s*(-?\d+)\s*\)?$/iu.exec(normalized);
    if (coord) return { id: 'navigate_to', params: { x: Number(coord[1]), y: Number(coord[2]), z: Number(coord[3]) } };
    const skill = skills.find(s => s.id !== 'navigate_to' && s.aliases.includes(normalized));
    return skill ? { id: skill.id, params: {} } : undefined;
  }
  compile(id: string, params: unknown, context: SkillContext): SkillResult {
    const skill = this.get(id); const parsed = skill?.params.safeParse(params);
    if (!skill || !parsed?.success) return { kind: 'clarify', question: '技能或参数无效，请重新描述目标。' };
    const result = skill.compile(parsed.data, context);
    if (result.kind !== 'actions') return result;
    const checked = z.array(actionSchema).min(1).safeParse(result.actions);
    return checked.success ? { ...result, actions: checked.data } : { kind: 'clarify', question: '技能动作没有通过校验。' };
  }
}
