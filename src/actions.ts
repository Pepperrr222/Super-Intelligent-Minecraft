import type { Bot } from 'mineflayer';
import pathfinderPackage from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { ActionError, ActionExecutor, type Context, type ExecuteOptions } from './executor.js';
import type { Action } from './schema.js';
import { Observations, itemDetails } from './observation.js';
import { runExtension, withWindow } from './extensions.js';
import { entityLookTarget } from './entity-look.js';
import { RecipeKnowledgeError, specialMaterial } from './recipes.js';
import { craftWithEvidence } from './crafting.js';
import { bindOperation, operationResult } from './operation-gateway.js';
import { operationCatalog } from './basic-operations.js';

const { pathfinder, Movements, goals } = pathfinderPackage;
const vector = (p: {x:number;y:number;z:number}) => new Vec3(p.x, p.y, p.z);
const faces = { up: new Vec3(0,1,0), down: new Vec3(0,-1,0), north: new Vec3(0,0,-1), south: new Vec3(0,0,1), east: new Vec3(1,0,0), west: new Vec3(-1,0,0) };
const requireCondition = (condition: unknown, code: string, message: string): void => { if (!condition) throw new ActionError(code, message); };

/** Owns movement, hand, inventory and container operations for one Bot. */
export class MinecraftActions {
  readonly executor: ActionExecutor;
  readonly observations: Observations;
  private alive: boolean;
  private disposed = false;
  private onSpawn = () => { this.observations.clearReferences(); this.alive = true; this.configureMovement(); };
  private onUnavailable = () => { this.observations.clearReferences(); this.alive = false; this.stop('机器人死亡或连接结束'); };
  private dimension?: string;
  private onGame = () => {
    const next = this.bot.game?.dimension;
    if (this.dimension && next && next !== this.dimension) this.observations.clearReferences();
    if (this.dimension && next && next!==this.dimension && !this.executor.waitingForDimension) this.stop('维度已改变，请重新观测目标');
    this.dimension = next;
  };

  constructor(private bot: Bot, knowledgeScope = 'local') {
    if (!bot.pathfinder) bot.loadPlugin(pathfinder);
    this.alive = Boolean(bot.entity && bot.health > 0);
    this.observations = new Observations(bot, 32, knowledgeScope);
    this.dimension = bot.game?.dimension;
    this.executor = new ActionExecutor((a, c) => this.run(a, c), () => this.alive && !this.disposed);
    bot.on('spawn', this.onSpawn);
    bot.on('death', this.onUnavailable);
    bot.on('end', this.onUnavailable);
    bot.on('kicked', this.onUnavailable);
    bot.on('game', this.onGame);
    if (this.alive) this.configureMovement();
  }
  private configureMovement() {
    const movements = new Movements(this.bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.scafoldingBlocks = [];
    this.bot.pathfinder.setMovements(movements);
  }
  execute(action: unknown, options?: ExecuteOptions) { return this.executor.execute(action, options); }
  stop(reason?: string) { this.executor.stop(reason); }
  get busy() { return this.executor.busy; }
  query(input: unknown) {
    if (!this.alive || this.disposed) return { status:'not_ready' };
    try { return this.observations.query(input); }
    catch (error) { return { status:'failed', error:error instanceof RecipeKnowledgeError || error instanceof ActionError
      ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error) }; }
  }
  dispose() {
    this.stop('动作控制器已释放'); this.disposed = true;
    this.bot.removeListener('spawn', this.onSpawn);
    for (const event of ['death', 'end', 'kicked'] as const) this.bot.removeListener(event, this.onUnavailable);
    this.bot.removeListener('game', this.onGame);
    this.observations.dispose();
  }
  observe() {
    return { ...this.observations.snapshot(), ready:this.alive && !this.disposed, busy:this.busy };
  }
  private block(p: {x:number;y:number;z:number}, reach = true) {
    const block = this.bot.blockAt(vector(p));
    if (!block) throw new ActionError('UNLOADED_BLOCK', '目标方块所在区块尚未加载');
    if (reach) this.near(block.position.offset(0.5,0.5,0.5), 4.5);
    return block;
  }
  private near(p: Vec3, distance: number) {
    const eye = this.bot.entity.position.offset(0, this.bot.entity.height ?? 1.62, 0);
    requireCondition(eye.distanceTo(p) <= distance, 'OUT_OF_REACH', '目标超出交互范围，请先导航接近');
  }
  private entity(id: number) {
    const entity = this.bot.entities[id];
    if (!entity || entity.isValid === false || entity === this.bot.entity || !this.observations.inRange(entity.position)) throw new ActionError('ENTITY_NOT_FOUND', '目标实体不可用或超出感知范围');
    return entity;
  }
  private itemType(name: string) {
    const item = this.bot.registry.itemsByName[name];
    if (!item) throw new ActionError('UNKNOWN_ITEM', `当前游戏版本没有物品 ${name}`);
    return item.id;
  }
  private amount(name: string) {
    const b = this.bot, w = b.currentWindow;
    const items = w ? w.slots.slice(w.inventoryStart,w.inventoryEnd) : b.inventory.items();
    return items.filter(i => i?.name === name).reduce((sum,i) => sum+(i?.count ?? 0),0);
  }
  private async run(a: Action, c: Context): Promise<unknown> {
    const b = this.bot;
    c.check();
    switch (a.type) {
      case 'operate': {
        const op = a.operation;
        const card = operationCatalog(b.version).find(card => card.type === op.type)!;
        requireCondition(card.available, 'UNSUPPORTED_VERSION', card.reason ?? '此操作当前不可用');
        const action = bindOperation(op, this.observations, b);
        c.check();
        const raw = await this.run(action, c); c.check();
        if (op.type === 'place') {
          const placed = (raw as { block?: string }).block;
          requireCondition(placed === op.item, 'PLACEMENT_UNCONFIRMED', '位置发生变化但未观测到指定方块');
        }
        if (op.type === 'equip' || op.type === 'unequip') {
          const slot = { hand: null, 'off-hand': 45, head: 5, torso: 6, legs: 7, feet: 8 }[op.destination];
          const current = slot === null ? b.heldItem : b.inventory.slots[slot];
          requireCondition(op.type === 'equip' ? current?.name === op.item : !current, 'EQUIPMENT_UNCONFIRMED', '没有观测到预期装备变化');
        }
        return { ...operationResult(op, raw, this.observations),
          ...(op.type === 'equip' || op.type === 'unequip' ? { evidence: 'client_equipment' } : {}) };
      }
      case 'wait': await c.sleep(a.durationMs); return { waitedMs:a.durationMs };
      case 'move': {
        requireCondition(!(a.controls.includes('forward') && a.controls.includes('back')) && !(a.controls.includes('left') && a.controls.includes('right')), 'CONFLICTING_CONTROLS', '不能同时向相反方向移动');
        c.cleanup(() => b.clearControlStates());
        for (const control of a.controls) b.setControlState(control, true);
        await c.sleep(a.durationMs);
        return { evidence:'duration_elapsed', position:b.entity.position.clone() };
      }
      case 'look': await b.look(a.yaw, a.pitch, true); return { yaw:b.entity.yaw, pitch:b.entity.pitch };
      case 'look_at': await b.lookAt(vector(a.position), true); return { yaw:b.entity.yaw, pitch:b.entity.pitch };
      case 'look_at_entity': {
        const entity = this.entity(a.entityId);
        const target = entityLookTarget(b,entity,a.part);
        await b.lookAt(target.position,true); c.check();
        requireCondition(this.entity(a.entityId)===entity,'TARGET_CHANGED','转向期间目标实体已被替换');
        return { evidence:'mineflayer_look_completed', entityId:a.entityId, part:a.part,
          targetPosition:target.position, heightOffset:target.heightOffset, heightSource:target.heightSource,
          yaw:b.entity.yaw, pitch:b.entity.pitch, tracking:false };
      }
      case 'navigate': {
        const goal = new goals.GoalNear(a.position.x,a.position.y,a.position.z,a.range);
        c.cleanup(() => { b.pathfinder.setGoal(null); b.clearControlStates(); });
        await b.pathfinder.goto(goal); c.check();
        // Mirror mineflayer-pathfinder's goal_reached check. It tests the
        // floored node and the node one block above, because standing on a
        // non-full block (snow layer, slab) makes the floored feet position
        // farther from the goal than the pathfinder considered arrived.
        const node = b.entity.position.floored();
        const destination = vector({
          x: Math.floor(a.position.x),
          y: Math.floor(a.position.y),
          z: Math.floor(a.position.z),
        });
        const arrived = node.distanceTo(destination) <= a.range
          || node.offset(0, 1, 0).distanceTo(destination) <= a.range;
        requireCondition(arrived, 'GOAL_NOT_REACHED', '导航结束但当前位置未满足目标');
        return { evidence:'position_observed', position:b.entity.position.clone() };
      }
      case 'follow': {
        const entity = this.entity(a.entityId);
        c.cleanup(() => { b.pathfinder.setGoal(null); b.clearControlStates(); });
        b.pathfinder.setGoal(new goals.GoalFollow(entity,a.distance), true);
        const end = Date.now()+a.durationMs;
        while (Date.now()<end) { this.entity(a.entityId); await c.sleep(Math.min(100,end-Date.now())); }
        return { evidence:'follow_interval_elapsed', distance:b.entity.position.distanceTo(entity.position), durationMs:a.durationMs };
      }
      case 'dig': {
        const block = this.block(a.position);
        requireCondition(b.canDigBlock(block) && block.diggable, 'CANNOT_DIG', '此方块当前不可挖掘');
        await b.lookAt(block.position.offset(0.5,0.5,0.5), true); c.check();
        requireCondition(b.blockAt(block.position)?.stateId === block.stateId, 'TARGET_CHANGED', '转向期间目标方块发生变化');
        c.cleanup(() => b.stopDigging());
        await b.dig(block, 'ignore'); c.check();
        const after = b.blockAt(block.position);
        requireCondition(after && after.stateId !== block.stateId, 'BLOCK_UNCHANGED', '客户端方块状态没有变化');
        return { evidence:'client_block_changed', before:block.name, after:after?.name, dropsCollected:false };
      }
      case 'place': {
        requireCondition(b.heldItem, 'EMPTY_HAND', '请先装备要放置的物品');
        const reference = this.block(a.reference), target = reference.position.plus(faces[a.face]);
        const before = b.blockAt(target);
        requireCondition(before, 'UNLOADED_BLOCK', '放置目标未加载');
        await b.placeBlock(reference,faces[a.face]); c.check();
        const after = b.blockAt(target);
        requireCondition(after && after.stateId !== before?.stateId, 'BLOCK_UNCHANGED', '放置位置的客户端状态没有变化');
        return { evidence:'client_block_changed', position:target, block:after?.name };
      }
      case 'equip': {
        const item = b.inventory.items().find(i => i.name===a.item);
        if (!item) throw new ActionError('MISSING_ITEM','背包中没有指定物品');
        await b.equip(item,a.destination); return { evidence:'mineflayer_completed', item:a.item, destination:a.destination };
      }
      case 'unequip': await b.unequip(a.destination); return { evidence:'mineflayer_completed', destination:a.destination };
      case 'select_slot': b.setQuickBarSlot(a.slot); return { evidence:'client_slot_selected', slot:a.slot };
      case 'use_item':
        requireCondition(a.offHand ? b.inventory.slots[45] : b.heldItem, 'EMPTY_HAND', '指定手中没有物品');
        c.cleanup(() => b.deactivateItem()); b.activateItem(a.offHand); await c.sleep(a.durationMs);
        return { evidence:'use_interval_elapsed', effectConfirmed:false };
      case 'consume': {
        requireCondition(b.heldItem, 'EMPTY_HAND', '请先装备可食用或可饮用物品');
        c.cleanup(() => b.deactivateItem()); await b.consume();
        return { evidence:'mineflayer_completed', food:b.food };
      }
      case 'activate_block': await b.activateBlock(this.block(a.position)); return { evidence:'interaction_sent', effectConfirmed:false };
      case 'activate_entity': {
        const entity = this.entity(a.entityId); this.near(entity.position,3);
        await b.activateEntity(entity); return { evidence:'interaction_sent', effectConfirmed:false };
      }
      case 'attack_once': {
        const entity = this.entity(a.entityId); this.near(entity.position,3);
        const isPlayer = (e: Bot['entity']) => e.type==='player' || e.name==='player' || Boolean(e.username);
        requireCondition(!isPlayer(entity) && !Object.values(b.entities).some(e=>e!==b.entity && e.isValid!==false && isPlayer(e) && e.position.distanceTo(entity.position)<4),'PLAYER_DAMAGE_RISK','目标是玩家，或附近玩家可能受到攻击波及');
        b.attack(entity); return { evidence:'attack_sent', damageConfirmed:false };
      }
      case 'craft': {
        const table = a.table ? this.block(a.table) : undefined;
        if (table) requireCondition(table.name==='crafting_table','NOT_CRAFTING_TABLE','目标不是工作台');
        return craftWithEvidence(b, c, a, table);
      }
      case 'toss': {
        const before = this.amount(a.item);
        requireCondition(before>=a.count,'INSUFFICIENT_ITEMS','背包数量不足');
        await b.toss(this.itemType(a.item),null,a.count); c.check();
        const removed = before-this.amount(a.item);
        requireCondition(removed===a.count,'INVENTORY_MISMATCH','丢出后的背包数量不符合预期');
        return { evidence:'inventory_delta', removed, recipientConfirmed:false };
      }
      case 'container_transfer': {
        const type = this.itemType(a.item), block = this.block(a.position), before = this.amount(a.item);
        return withWindow(b,c,()=>b.openContainer(block),async window=> {
          this.observations.containers.capture(a.position,window,itemDetails);
          c.check();
          const candidates = a.direction==='withdraw' ? window.slots.slice(0,window.inventoryStart)
            : window.slots.slice(window.inventoryStart,window.inventoryEnd);
          requireCondition(!candidates.some(i=>i?.name===a.item && specialMaterial(i)),
            'SPECIAL_MATERIAL_SELECTION_REQUIRED','存在同名特殊物品，按名称转移不能保证保留它，请先明确分开存放');
          try { await window[a.direction](type,null,a.count); c.check(); }
          catch (error) { this.observations.containers.invalidate(a.position); throw error; }
          this.observations.containers.capture(a.position,window,itemDetails);
          const delta = this.amount(a.item)-before, expected = a.direction==='deposit' ? -a.count : a.count;
          requireCondition(delta===expected,'INVENTORY_MISMATCH','转移后的背包变化不符合预期');
          return { evidence:'inventory_delta', delta };
        });
      }
      default: return runExtension(a,c,{ bot:b, observations:this.observations,
        block:p=>this.block(p), entity:id=>this.entity(id), near:(p,d)=>this.near(p,d) });
    }
  }
}
