import { z } from 'zod';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { specialMaterial } from './recipes.js';

const position = z.object({ x:z.number().int(), y:z.number().int(), z:z.number().int() });
export const containerRecordSchema = z.object({
  id:z.string(), scope:z.string(), dimension:z.string(), positions:z.array(position).min(1).max(2),
  block:z.string(), observedAt:z.number(), status:z.enum(['historical','invalidated']),
  slots:z.array(z.object({ slot:z.number().int(), name:z.string(), count:z.number().int().nonnegative(),
    special:z.boolean(), attributes:z.unknown().optional() })).max(256),
});
export const resourceMemorySchema = z.object({
  containers:z.array(containerRecordSchema).max(128),
});
export type ResourceMemory = z.infer<typeof resourceMemorySchema>;
export interface MemoryPort {
  restore(data: ResourceMemory):void;
  snapshot():ResourceMemory;
  subscribe(listener:()=>void):()=>void;
}

/** Historical observations, never a second source of immediately spendable inventory. */
export class ContainerMemory implements MemoryPort {
  private records: ResourceMemory['containers'] = [];
  private listeners = new Set<()=>void>();
  constructor(private bot: Bot, readonly scope: string) {}
  restore(data: ResourceMemory) { this.records = resourceMemorySchema.parse(data).containers.filter(r => r.scope === this.scope); }
  snapshot(): ResourceMemory { return structuredClone({containers:this.records}); }
  subscribe(listener:()=>void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  private key(p: {x:number;y:number;z:number}) { return `${p.x},${p.y},${p.z}`; }
  capture(p: {x:number;y:number;z:number}, window: {inventoryStart:number; slots: readonly any[]}, details:(item:any)=>any) {
    const block = this.bot.blockAt(new Vec3(p.x,p.y,p.z));
    if (!block || !this.bot.game?.dimension) return;
    const positions = [{x:p.x,y:p.y,z:p.z}];
    const props = block.getProperties();
    if (['chest','trapped_chest'].includes(block.name) && props.type !== 'single' && window.inventoryStart === 54) {
      const facing = String(props.facing), facingOffset: Record<string,[number,number]> = { north:[1,0],south:[-1,0],west:[0,-1],east:[0,1] };
      const offset = facingOffset[facing];
      if (offset && ['left','right'].includes(String(props.type))) {
        const sign = props.type === 'left' ? 1 : -1;
        const other = block.position.offset(offset[0]*sign,0,offset[1]*sign);
        const partner = this.bot.blockAt(other), otherProps = partner?.getProperties();
        if (partner?.name === block.name && otherProps?.facing === props.facing && otherProps.type !== props.type && otherProps.type !== 'single')
          positions.push({x:other.x,y:other.y,z:other.z});
      }
      // Do not store an ambiguous 54-slot window as a separate chest half.
      if (positions.length !== 2) return;
    }
    positions.sort((a,b) => this.key(a).localeCompare(this.key(b)));
    const dimension = String(this.bot.game.dimension);
    // Ender-chest contents belong to the bot, shared across all locations/dimensions.
    const id = block.name === 'ender_chest' ? `${this.scope}:ender_inventory`
      : `${this.scope}:${dimension}:${positions.map(p=>this.key(p)).join('|')}`;
    const slots = window.slots.slice(0,window.inventoryStart).flatMap((item,slot) => {
      if (!item) return [];
      const d = details(item);
      return [{slot,name:item.name,count:item.count,
        special:specialMaterial(d),
        attributes:{customName:d?.customName,enchants:d?.enchants,durabilityUsed:d?.durabilityUsed}}];
    });
    this.records = this.records.filter(r => r.id !== id && !(r.dimension === dimension && r.positions.some(q => positions.some(p => this.key(q) === this.key(p)))));
    this.records.push({id,scope:this.scope,dimension,positions,block:block.name,observedAt:Date.now(),status:'historical',slots});
    this.records = this.records.slice(-128); this.changed();
  }
  invalidate(p: {x:number;y:number;z:number}) {
    let changed = false;
    for (const r of this.records) if (r.dimension === this.bot.game?.dimension && r.positions.some(q => this.key(q) === this.key(p))) {
      r.status = 'invalidated'; changed = true;
    }
    if (changed) this.changed();
  }
  query(items: string[] = [], limit = 16) {
    const records = this.records.filter(r => r.dimension === this.bot.game?.dimension)
      .filter(r => !items.length || r.slots.some(s => items.includes(s.name)))
      .sort((a,b) => b.observedAt-a.observedAt);
    return { scope:this.scope, historicalOnly:true, permissionGranted:false, total:records.length, truncated:records.length>limit,
      containers: records.slice(0,limit).map(r => ({...r, ageMs:Date.now()-r.observedAt,
        distance:this.bot.entity?.position.distanceTo(new Vec3(r.positions[0]!.x,r.positions[0]!.y,r.positions[0]!.z)),
        slots: r.slots.filter(s => !items.length || items.includes(s.name)), requiresInspection:true })) };
  }
}
