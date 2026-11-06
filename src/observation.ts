import { createHash, randomUUID } from 'node:crypto';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { querySchema, type Condition } from './schema.js';
import { BotRecipeProvider, evaluateRecipe, planningInventory, specialMaterial } from './recipes.js';
import type { BasicOperation } from './schema.js';
import { expandRequirements } from './requirements.js';
import { TargetRegistry } from './targets.js';
import { OperationReferences } from './operation-references.js';
import { droppedItem } from './entity-observation.js';
import { operationSchemas } from './basic-operations.js';
import { craftingOptions, resolveRecipeHandle } from './crafting-knowledge.js';
import { ContainerMemory } from './resource-memory.js';

export type Item = NonNullable<Bot['heldItem']>;
export const plain = (value: unknown): any => value == null ? null : JSON.parse(JSON.stringify(value, (_, v) =>
  typeof v === 'bigint' ? v.toString() : v instanceof Map ? Object.fromEntries(v) : v));
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(plain(value)))).digest('hex');
const read = (fn: () => unknown) => { try { return plain(fn()); } catch { return null; } };
export function itemDetails(item: Item | null | undefined) {
  if (!item) return null;
  const runtime = item as Item & { components?: unknown; removedComponents?: unknown };
  return { name:item.name, count:item.count, metadata:item.metadata,
    durabilityUsed:read(() => item.durabilityUsed), maxDurability:item.maxDurability ?? null,
    enchants:read(() => item.enchants), customName:read(() => item.customName),
    components:read(() => runtime.components), removedComponents:read(() => runtime.removedComponents), nbt:read(() => item.nbt) };
}
export const itemFingerprint = (item: Item) => fingerprint(itemDetails(item));
export const itemIdentity = (item: Item) => fingerprint({ ...itemDetails(item), count:0 });
export type Verification = { value: true | false | 'unknown'; evidence: string; observed: unknown };
const TOOL_SUFFIX = /_(?:pickaxe|axe|shovel|hoe)$/u;
const ARMOR_SUFFIX = /_(?:helmet|chestplate|leggings|boots)$/u;
const WEAPON_NAME = /^(?:bow|crossbow|trident|arrow|spectral_arrow|tipped_arrow)$|_sword$/u;
const EXTRA_TOOLS = new Set(['shears', 'flint_and_steel', 'fishing_rod', 'brush', 'carrot_on_a_stick', 'warped_fungus_on_a_stick']);
export function inventoryFlags(name: string, registry?: Bot['registry']) {
  const block = !!registry?.blocksByName?.[name];
  const armor = ARMOR_SUFFIX.test(name);
  const tool = !armor && (TOOL_SUFFIX.test(name) || EXTRA_TOOLS.has(name));
  const weapon = WEAPON_NAME.test(name);
  return { ...(block ? { block: true } : {}), ...(tool ? { tool: true } : {}), ...(armor ? { armor: true } : {}), ...(weapon ? { weapon: true } : {}) };
}

/** Only loaded client data within a bounded public perception radius; never server/grader data. */
export class Observations {
  readonly recipes: BotRecipeProvider;
  readonly containers: ContainerMemory;
  readonly targets: TargetRegistry;
  readonly operationReferences: OperationReferences;
  readonly sessionId = randomUUID();
  tick = 0;
  private onTick = () => { this.tick++; };
  constructor(private bot: Bot, readonly radius = 32, scope = 'local') {
    this.recipes = new BotRecipeProvider(bot); this.containers = new ContainerMemory(bot, scope);
    this.targets = new TargetRegistry(bot); this.operationReferences = new OperationReferences(bot, itemFingerprint);
    bot.on('physicsTick', this.onTick);
    bot.on('blockUpdate', this.onBlockUpdate);
  }
  private onBlockUpdate = (before: any, after: any) => {
    if (before && after && (before.name !== after.name || JSON.stringify(before.getProperties()) !== JSON.stringify(after.getProperties())))
      this.containers.invalidate(before.position);
  };
  clearReferences() { this.targets.clear(); this.operationReferences.clear(); }
  dispose() { this.clearReferences(); this.bot.removeListener('physicsTick', this.onTick); this.bot.removeListener('blockUpdate', this.onBlockUpdate); }
  resolveRecipe(item: string, ref: string) { return resolveRecipeHandle(this.recipes,item,ref).recipeRef; }
  validateTargets(operations:BasicOperation[]) {
    const digRefs = new Set<string>();
    for (const op of operations) {
      const refs=[...('targetRef' in op?[op.targetRef]:[]),...('tableRef' in op && op.tableRef?[op.tableRef]:[])];
      for(const ref of refs) this.targets.resolve(ref,['block','entity','placement','position']);
      if(op.type==='dig') {
        if(digRefs.has(op.targetRef)) throw new Error('DUPLICATE_DIG_TARGET: 同批次不能重复挖同一个目标，请重新选择');
        digRefs.add(op.targetRef);
      }
    }
  }
  validateCrafts(operations:BasicOperation[]):string | undefined {
    let stock = planningInventory(this.bot), known = true;
    for (const op of operations) {
      if (op.type==='craft' || op.type==='craft_output') {
        const record = resolveRecipeHandle(this.recipes,op.item,op.recipeRef);
        const count = op.type==='craft_output' ? op.outputCount : op.count ?? op.repetitions! * record.result.count;
        if (record.facility==='crafting_table' && !op.tableRef) return `${op.item} 需要明确的工作台 tableRef`;
        if (known) {
          const evaluation = evaluateRecipe(record,count,stock,op.tableRef?['crafting_table']:[]);
          if (!evaluation.craftable) return `材料不足：${JSON.stringify(evaluation.ingredients.filter(i=>i.missing>0))}；先完成取材或前置合成`;
          for (const i of evaluation.ingredients) {
            let remaining=i.required;
            for (const s of stock) if(s.item===i.item) {const taken=Math.min(s.count,remaining);s.count-=taken;remaining-=taken;}
          }
          stock.push({item:record.result.item,count:evaluation.outputCount});
        }
      } else if (['container_transfer','dig','navigate','toss','consume','place','place_entity','use_item','activate_block','trade'].includes(op.type)) known=false;
    }
    return undefined;
  }
  inRange(p: {x:number;y:number;z:number}, radius = this.radius) {
    return !!this.bot.entity && this.bot.entity.position.distanceTo(new Vec3(p.x,p.y,p.z)) <= radius;
  }
  inspectBlock(p: {x:number;y:number;z:number}) {
    if (!this.inRange(p)) return { known:false as const, reason:'OUTSIDE_PERCEPTION' };
    const block = this.bot.blockAt(new Vec3(p.x,p.y,p.z));
    if (!block) return { known:false as const, reason:'UNLOADED_BLOCK' };
    return { ...this.targets.observeBlock(p), known:true as const, name:block.name, position:plain(block.position), stateId:block.stateId,
      properties:read(() => block.getProperties()), diggable:block.diggable };
  }
  snapshot(radius = 16) {
    const b = this.bot;
    const w = b.currentWindow;
    const inventory = w ? w.slots.slice(w.inventoryStart,w.inventoryEnd).flatMap((item,index)=>item ? [{item,slot:b.inventory.inventoryStart+index}] : [])
      : (b.inventory?.items() ?? []).map(item=>({item,slot:item.slot}));
    return { sessionId:this.sessionId, clientTick:this.tick, timestamp:Date.now(), version:b.version,
      perceptionRadius:Math.min(radius,this.radius), position:plain(b.entity?.position),
      velocity:plain(b.entity?.velocity), onGround:b.entity?.onGround ?? null,
      health:b.health, food:b.food, oxygen:b.oxygenLevel ?? null, experience:plain(b.experience),
      dimension:b.game?.dimension, gameMode:b.game?.gameMode, effects:plain(b.entity?.effects),
      vehicle:b.vehicle ? { id:b.vehicle.id, name:b.vehicle.name } : null,
      inventory:inventory.map(({item,slot}) => {
        const food = this.bot.registry.foodsByName?.[item.name];
        return { ...itemDetails(item), slot, fingerprint:itemFingerprint(item), ...inventoryFlags(item.name, this.bot.registry), ...(food ? { food:true, foodPoints:food.foodPoints } : {}) };
      }),
      heldItem: itemDetails(b.heldItem),
      equipment: [5,6,7,8,45].map(slot => ({ slot, item:itemDetails(b.inventory?.slots[slot]) })),
      entitiesTruncated:Object.values(b.entities ?? {}).filter(e=>e!==b.entity && e.isValid!==false && this.inRange(e.position,Math.min(radius,this.radius))).length>64,
      entities:Object.values(b.entities ?? {}).filter(e => e !== b.entity && e.isValid !== false && this.inRange(e.position,Math.min(radius,this.radius)))
        .sort((a,c)=>a.position.distanceTo(b.entity.position)-c.position.distanceTo(b.entity.position)).slice(0,64)
        .map(e => ({ ...this.targets.observeEntity(e), id:e.id, uuid:e.uuid ?? null, name:e.name, type:e.type, username:e.username,
          position:plain(e.position), velocity:plain(e.velocity), droppedItem:droppedItem(e), metadata:read(() => e.metadata),
          metadataMeaning:'raw_version_specific', observedTick:this.tick })) };
  }
  verify(condition: Condition): Verification {
    const b = this.bot;
    const unknown = (reason: string): Verification => ({ value:'unknown', evidence:reason, observed:null });
    if (!b.entity) return unknown('NOT_READY');
    switch (condition.kind) {
      case 'inventory_at_least': {
        const w = b.currentWindow, items = w ? w.slots.slice(w.inventoryStart,w.inventoryEnd) : b.inventory.items();
        const observed = items.filter(i => i?.name===condition.item).reduce((n,i)=>n+(i?.count ?? 0),0);
        return { value:observed>=condition.count, evidence:'client_inventory_count', observed };
      }
      case 'block_is': {
        const block = this.inspectBlock(condition.position);
        if (!block.known) return unknown(block.reason);
        if (block.name !== condition.name) return { value:false, evidence:'client_block', observed:block };
        for (const [key,value] of Object.entries(condition.properties ?? {})) {
          if (!block.properties || !(key in block.properties)) return unknown('UNDECODED_PROPERTY');
          if (block.properties[key] !== value) return { value:false, evidence:'client_block_property', observed:block };
        }
        return { value:true, evidence:'client_block', observed:block };
      }
      case 'dimension_is': return b.game?.dimension ? { value:b.game.dimension===condition.dimension, evidence:'client_dimension', observed:b.game.dimension } : unknown('DIMENSION_UNKNOWN');
      case 'health_at_least': return Number.isFinite(b.health) ? { value:b.health>=condition.health, evidence:'client_health', observed:b.health } : unknown('HEALTH_UNKNOWN');
      case 'entity_near': {
        const entity = b.entities[condition.entityId];
        if (!entity || entity.isValid===false || !this.inRange(entity.position)) return unknown('ENTITY_NOT_OBSERVED');
        const distance = b.entity.position.distanceTo(entity.position);
        return { value:distance<=condition.distance, evidence:'client_entity_distance', observed:distance };
      }
    }
  }
  query(input: unknown) {
    const parsed = querySchema.safeParse(input);
    if (!parsed.success) return { status:'invalid', error:parsed.error.message };
    if (!this.bot.entity) return { status:'not_ready' };
    const q = parsed.data, b = this.bot;
    switch (q.type) {
      case 'container_memory': return {status:'succeeded',data:this.containers.query(q.items,q.limit)};
      case 'crafting_options': {
        const raw = this.snapshot().inventory;
        const protectedItems = raw.filter(specialMaterial);
        const inventory = raw.filter(i => !protectedItems.includes(i) && i.name && i.count).map(i => ({item:i.name!,count:i.count!}));
        const data = craftingOptions(this.recipes,q,inventory,protectedItems.filter(i=>i.name && i.count).map(i=>({item:i.name!,count:i.count!})));
        const relevant = new Set<string>();
        for (const goal of q.goals) for (const recipe of this.recipes.lookup(goal.item)) for (const i of recipe.ingredients) relevant.add(i.item);
        for (const i of data.dependencies?.missing ?? []) relevant.add(i.item);
        return {status:'succeeded', data:{...data, excludedSpecialItems:protectedItems.map(i=>({item:i.name,count:i.count})),
          containerHints:this.containers.query([...relevant],8)}};
      }
      case 'register_position': return { status: 'succeeded', data: this.targets.registerPosition(q.position) };
      case 'observe_inventory': return { status: 'succeeded', data: this.operationReferences.observe(q.offset, q.limit) };
      case 'operation_schema': return { status: 'succeeded', data: { schemas: operationSchemas(q.types) } };
      case 'observe_targets': return { status: 'succeeded', data: this.targets.observe(q) };
      case 'recipe_lookup': {
        const provider = this.recipes;
        const all = provider.lookup(q.item);
        return { status: 'succeeded', data: {
          source: provider.source, version: provider.version, revision: provider.revision,
          scope: 'local_version_rules', serverRulesVerified: false,
          recipes: all.slice(q.offset, q.offset + q.limit), total: all.length,
          nextOffset: q.offset + q.limit < all.length ? q.offset + q.limit : null,
        } };
      }
      case 'recipe_evaluate': {
        const { record } = this.recipes.resolve(q.item, q.recipeRef);
        const inventory = planningInventory(b);
        return { status: 'succeeded', data: {
          ...evaluateRecipe(record, q.count, inventory, q.facilities),
          assumedFacilities: q.facilities, facilityObserved: false, serverRulesVerified: false,
        } };
      }
      case 'requirements_expand': {
        const inventory = planningInventory(b);
        return { status: 'succeeded', data: expandRequirements(this.recipes, q, inventory) };
      }
      case 'snapshot': return { status:'succeeded', data:this.snapshot(q.radius) };
      case 'inspect_block': return { status:'succeeded', data:this.inspectBlock(q.position) };
      case 'verify': return { status:'succeeded', data:this.verify(q.condition) };
      case 'find_blocks': {
        const unknown = q.names.filter(n => !b.registry.blocksByName[n]);
        if (unknown.length) return { status:'invalid', error:`UNKNOWN_BLOCK: ${unknown.join(', ')}` };
        const positions = b.findBlocks({ matching:q.names.map(n=>b.registry.blocksByName[n].id), maxDistance:Math.min(q.radius,this.radius), count:q.limit });
        return { status:'succeeded', data:{ scope:'loaded_client_chunks', completeWorldSearch:false, blocks:positions.filter(p=>this.inRange(p,q.radius)).map(p=>this.inspectBlock(p)) } };
      }
      case 'recipes': {
        const item = b.registry.itemsByName[q.item];
        if (!item) return { status:'invalid', error:'UNKNOWN_ITEM' };
        if (q.table && !this.inRange(q.table)) return { status:'invalid', error:'OUTSIDE_PERCEPTION' };
        const table = q.table ? b.blockAt(new Vec3(q.table.x,q.table.y,q.table.z)) : null;
        if (q.table && table?.name!=='crafting_table') return { status:'invalid', error:'NO_OBSERVED_CRAFTING_TABLE' };
        const itemName = (id: number) => b.registry.items[id]?.name ?? null;
        return { status:'succeeded', data:plain(b.recipesFor(item.id,null,1,table).map(r=>({
          result: { ...r.result, name: itemName(r.result.id) },
          delta: r.delta.map(entry => ({ ...entry, name: itemName(entry.id) })),
          requiresTable: r.requiresTable,
        }))) };
      }
    }
  }
}
