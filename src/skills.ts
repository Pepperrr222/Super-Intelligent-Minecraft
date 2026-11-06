import { z, type ZodType } from 'zod';
import { actionSchema, type Action, type Condition } from './schema.js';
import {
  collectDropsParamsSchema,
  craftItemParamsSchema,
  deliverToPlayerParamsSchema,
  findResourceParamsSchema,
  gatherWoodParamsSchema,
  navigateToParamsSchema,
  storeItemsParamsSchema,
} from './builtin-skills.js';

export const INVENTORY_FILTERS = ['food', 'tools', 'blocks', 'armor', 'weapons', 'all'] as const;
export type InventoryFilter = typeof INVENTORY_FILTERS[number];
export const inventoryFilterSchema = z.enum(INVENTORY_FILTERS);

type InventoryItem = { name: string; count: number; food?: boolean; foodPoints?: number; tool?: boolean; block?: boolean; armor?: boolean; weapon?: boolean };
export type SkillCompileContext = {
  player: string;
  snapshot?: { inventory?: InventoryItem[]; entities?: Array<{ id: number; username?: string; name?: string; position?: { x: number; y: number; z: number } }> };
  followDurationMs?: number;
  navigateRange?: number;
};
export type SkillCompileResult = { kind: 'actions'; actions: Action[]; ack: string } | { kind:'dynamic'; skill:{id:string;params:Record<string,unknown>}; ack:string } | { kind: 'reply'; text: string } | { kind: 'clarify'; question: string };
export type Skill = {
  id: string; description?: string; params: ZodType; preconditions: Condition[]; postconditions: Condition[];
  risk: 'safe' | 'confirm' | 'destructive'; idempotent: boolean;
  compile(params: any, context: SkillCompileContext): SkillCompileResult;
};
const empty = z.object({}).strict();
const inventoryParams = z.object({ filter: inventoryFilterSchema.optional() }).strict();
const player = (c: SkillCompileContext) => c.snapshot?.entities?.find(e => e.username?.toLowerCase() === c.player.toLowerCase() || e.name?.toLowerCase() === c.player.toLowerCase());
const missing = (c: SkillCompileContext): SkillCompileResult => ({ kind: 'clarify', question: `我看不到你（${c.player}），靠近一点再试。` });
const filterLabels: Record<Exclude<InventoryFilter, 'all'>, string> = { food: '食物', tools: '工具', blocks: '方块', armor: '盔甲', weapons: '武器' };
function matchesFilter(item: InventoryItem, filter: InventoryFilter): boolean {
  if (filter === 'all') return true;
  return filter === 'food' ? !!item.food : filter === 'tools' ? !!item.tool : filter === 'blocks' ? !!item.block : filter === 'armor' ? !!item.armor : !!item.weapon;
}
export const skills: Skill[] = [
  { id:'gather_wood', description:'采集附近原木；未指定树种时自动选择可采集的树种', params:gatherWoodParamsSchema, preconditions:[],postconditions:[],risk:'confirm',idempotent:false,
    compile:(p)=>({kind:'dynamic',skill:{id:'gather_wood',params:p},ack:p.woodType?`开始采集 ${p.count} 个 ${p.woodType} 原木。`:`开始采集 ${p.count} 个原木（自动选择附近树种）。`}) },
  { id:'find_resource', description:'寻找附近指定方块并返回候选位置', params:findResourceParamsSchema, preconditions:[],postconditions:[],risk:'safe',idempotent:true,
    compile:(p)=>({kind:'dynamic',skill:{id:'find_resource',params:p},ack:`正在寻找 ${p.names.join('、')}。`}) },
  { id:'collect_drops', description:'接近并拾取附近的掉落物，核对背包增量', params:collectDropsParamsSchema, preconditions:[],postconditions:[],risk:'safe',idempotent:false,
    compile:(p)=>({kind:'dynamic',skill:{id:'collect_drops',params:p},ack:'正在拾取附近的掉落物。'}) },
  { id:'craft_item', description:'按目标数量制作物品，检查材料和工作台', params:craftItemParamsSchema, preconditions:[],postconditions:[],risk:'confirm',idempotent:false,
    compile:(p)=>({kind:'dynamic',skill:{id:'craft_item',params:p},ack:`准备制作 ${p.count} 个 ${p.item}。`}) },
  { id:'store_items', description:'把背包物品存入指定箱子', params:storeItemsParamsSchema, preconditions:[],postconditions:[],risk:'confirm',idempotent:false,
    compile:(p)=>({kind:'dynamic',skill:{id:'store_items',params:p},ack:`准备把 ${p.count} 个 ${p.item} 放进箱子。`}) },
  { id:'deliver_to_player', description:'接近玩家并丢出物品，明确接收无法确认', params:deliverToPlayerParamsSchema, preconditions:[],postconditions:[],risk:'confirm',idempotent:false,
    compile:(p)=>({kind:'dynamic',skill:{id:'deliver_to_player',params:p},ack:`准备把 ${p.count} 个 ${p.item} 交给 ${p.player ?? '你'}。`}) },
  { id: 'follow_player', params: empty, preconditions: [], postconditions: [], risk: 'safe', idempotent: false,
    compile: (_p, c) => { const entity = player(c); return entity ? { kind: 'actions', actions: [{ type: 'follow', entityId: entity.id, distance: 2, durationMs: c.followDurationMs ?? 30000 }], ack: `跟着你（先跟 ${Math.round((c.followDurationMs ?? 30000) / 1000)} 秒）。` } : missing(c); } },
  { id: 'come_to_player', params: empty, preconditions: [], postconditions: [], risk: 'safe', idempotent: true,
    compile: (_p, c) => { const pos = player(c)?.position; return pos ? { kind: 'actions', actions: [{ type: 'navigate', position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, range: c.navigateRange ?? 2 }], ack: '正在过去。' } : missing(c); } },
  { id: 'navigate_to', description: '导航到坐标并复查最终位置', params: navigateToParamsSchema, preconditions: [], postconditions: [], risk: 'safe', idempotent: true,
    compile: (p) => ({ kind: 'dynamic', skill: { id: 'navigate_to', params: p }, ack: '收到，开始导航。' }) },
  { id: 'report_inventory', params: inventoryParams, preconditions: [], postconditions: [], risk: 'safe', idempotent: true,
    compile: (p: { filter?: InventoryFilter }, c) => {
      if (!c.snapshot) return { kind: 'reply', text: '我现在看不到背包状态。' };
      const inventory = c.snapshot.inventory ?? [];
      const filter = p.filter ?? 'all';
      const items = inventory.filter(item => matchesFilter(item, filter));
      if (items.length === 0) return { kind: 'reply', text: filter === 'all' ? '背包是空的。' : `背包里没有${filterLabels[filter]}。` };
      const counts = new Map<string, number>();
      for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
      return { kind: 'reply', text: `背包里有：${[...counts].sort(([a],[b]) => a.localeCompare(b)).map(([name,count]) => `${name} x${count}`).join('，')}。` };
    } },
];
export class SkillCatalog {
  get(id: string): Skill | undefined { return skills.find(s => s.id === id); }
  compile(id: string, params: unknown, context: SkillCompileContext): SkillCompileResult {
    const skill = this.get(id); const parsed = skill?.params.safeParse(params);
    if (!skill || !parsed?.success) return { kind: 'clarify', question: '技能或参数无效，请重新描述目标。' };
    const result = skill.compile(parsed.data, context);
    if (result.kind !== 'actions') return result;
    const checked = z.array(actionSchema).min(1).safeParse(result.actions);
    return checked.success ? { ...result, actions: checked.data } : { kind: 'clarify', question: '技能动作没有通过校验。' };
  }
}
