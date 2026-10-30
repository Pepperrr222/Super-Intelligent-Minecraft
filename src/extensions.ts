import type { Bot, VillagerTrade } from 'mineflayer';
import { Vec3 } from 'vec3';
import { ActionError, type Context } from './executor.js';
import type { Action } from './schema.js';
import { Observations, itemDetails, itemFingerprint, itemIdentity, fingerprint, plain, type Item } from './observation.js';
import { until, physicsTicks } from './control.js';

type Host = { bot: Bot; observations: Observations;
  block(p: {x:number;y:number;z:number}): NonNullable<ReturnType<Bot['blockAt']>>;
  entity(id: number): Bot['entity']; near(p: Vec3, distance: number): void };
function need(ok: unknown, code: string, message: string): asserts ok { if (!ok) throw new ActionError(code,message); }
const faces = { up:new Vec3(0,1,0), down:new Vec3(0,-1,0), north:new Vec3(0,0,-1), south:new Vec3(0,0,1), east:new Vec3(1,0,0), west:new Vec3(-1,0,0) };
const inventory = (b: Bot) => b.currentWindow ? b.currentWindow.slots.slice(b.currentWindow.inventoryStart,b.currentWindow.inventoryEnd).filter((i): i is Item=>!!i) : b.inventory.items();
const amount = (b: Bot, name: string) => inventory(b).filter(i=>i.name===name).reduce((n,i)=>n+i.count,0);
const matchingAmount = (b: Bot, item: Item) => inventory(b).filter(i=>itemIdentity(i)===itemIdentity(item)).reduce((n,i)=>n+i.count,0);
const typeOf = (b: Bot, name: string) => { const type = b.registry.itemsByName[name]; need(type,'UNKNOWN_ITEM',`未知物品 ${name}`); return type.id; };
function resolveSlot(b: Bot, ref: {slot:number;fingerprint:string}) {
  const item = b.inventory.slots[ref.slot];
  need(item && itemFingerprint(item)===ref.fingerprint,'STALE_ITEM','背包槽位已改变，请重新观测');
  return item!;
}
function windowItem(b: Bot, item: Item) {
  const w = b.currentWindow!;
  const slot = w.inventoryStart + item.slot - b.inventory.inventoryStart;
  const current = w.slots[slot];
  need(current && itemFingerprint(current)===itemFingerprint(item),'STALE_ITEM','打开窗口后物品已移动或改变');
  return current!;
}
type WindowLike = { close(): unknown };
/** The opener and all GUI writes share the outer executor lease, including late opens. */
export async function withWindow<W extends WindowLike,T>(b: Bot, c: Context, open:()=>Promise<W>, work:(window:W)=>Promise<T>): Promise<T> {
  need(!b.currentWindow,'WINDOW_BUSY','请先关闭已有窗口');
  let w: W | undefined;
  const close = () => {
    if (w && b.currentWindow === w as unknown) return Promise.resolve(w.close());
    return Promise.resolve();
  };
  try {
    w = await open(); c.check();
    c.cleanup(()=>{ void close().catch(()=>{}); });
    return await work(w);
  } finally {
    // Native open wrappers can throw after openBlock has already installed a window.
    if (!w && b.currentWindow) await b.closeWindow(b.currentWindow);
    else await close();
  }
}
function offerDetails(t: VillagerTrade) {
  return { input:itemDetails(t.inputItem1), second:t.hasItem2 ? itemDetails(t.inputItem2) : null,
    output:itemDetails(t.outputItem), price:t.realPrice ?? t.inputItem1.count,
    disabled:t.tradeDisabled, uses:t.nbTradeUses, maxUses:t.maximumNbTradeUses };
}
function offerKey(t: VillagerTrade) {
  const { disabled, uses, maxUses, ...terms } = offerDetails(t);
  return fingerprint(terms);
}
function allowVehicle(name?: string) { return !!name && /^(?:[a-z_]+_)?(?:boat|chest_boat|raft|chest_raft)$/.test(name); }

export async function runExtension(a: Action, c: Context, h: Host): Promise<unknown> {
  const b = h.bot;
  switch (a.type) {
    case 'wait_ticks': return { evidence:'client_physics_ticks', ticks:await physicsTicks(c,b,a.ticks) };
    case 'move_ticks': {
      need(!(a.controls.includes('forward') && a.controls.includes('back')) && !(a.controls.includes('left') && a.controls.includes('right')),'CONFLICTING_CONTROLS','不能同时向相反方向移动');
      c.cleanup(()=>b.clearControlStates());
      for (const control of a.controls) b.setControlState(control,true);
      return { evidence:'client_physics_ticks', ticks:await physicsTicks(c,b,a.ticks), position:plain(b.entity.position) };
    }
    case 'use_item_ticks': {
      need(a.offHand ? b.inventory.slots[45] : b.heldItem,'EMPTY_HAND','指定手中没有物品');
      c.cleanup(()=>b.deactivateItem()); b.activateItem(a.offHand);
      return { evidence:'client_physics_ticks', ticks:await physicsTicks(c,b,a.ticks), effectConfirmed:false };
    }
    case 'wait_until': {
      await until(c,b,['physicsTick','blockUpdate','health','game','entityMoved'],()=>h.observations.verify(a.condition).value===true);
      return h.observations.verify(a.condition);
    }
    case 'place_entity': {
      need(b.heldItem,'EMPTY_HAND','请先装备载具或可放置实体物品');
      const entity = await b.placeEntity(h.block(a.reference),faces[a.face]); c.check();
      need(entity?.isValid!==false && entity?.id != null,'ENTITY_NOT_OBSERVED','没有观测到放置的实体');
      return { evidence:'client_entity_spawn', entityId:entity.id, name:entity.name, position:plain(entity.position) };
    }
    case 'activate_entity_at': {
      const entity = h.entity(a.entityId), point = entity.position.offset(a.offset.x,a.offset.y,a.offset.z);
      need(Math.abs(a.offset.x)<=2 && Math.abs(a.offset.z)<=2 && a.offset.y>=0 && a.offset.y<= (entity.height ?? 2),'INVALID_HIT_POINT','交互偏移不在实体附近');
      h.near(point,3); await b.activateEntityAt(entity,point);
      return { evidence:'interaction_sent', effectConfirmed:false };
    }
    case 'craft_output': {
      const table = a.table ? h.block(a.table) : null;
      if (table) need(table.name==='crafting_table','NOT_CRAFTING_TABLE','目标不是工作台');
      const recipe = b.recipesFor(typeOf(b,a.item),null,1,table)[0];
      need(recipe,'NO_RECIPE','没有材料足够的配方');
      const repetitions = Math.ceil(a.outputCount/recipe.result.count);
      const before = amount(b,a.item);
      await b.craft(recipe,repetitions,table ?? undefined); c.check();
      const gained = amount(b,a.item)-before;
      need(gained>=a.outputCount,'INVENTORY_MISMATCH','产物增量不足');
      return { evidence:'inventory_delta', requested:a.outputCount, gained, repetitions };
    }
    case 'container_inspect': return withWindow(b,c,()=>b.openContainer(h.block(a.position)),async w=>
      ({ evidence:'client_window', windowType:w.type, items:w.slots.slice(0,w.inventoryStart).map((i,slot)=>({slot,item:itemDetails(i)})) }));
    case 'inventory_move': {
      need(!b.currentWindow,'WINDOW_BUSY','背包整理时不能有已打开窗口');
      need(!b.inventory.selectedItem,'CURSOR_OCCUPIED','鼠标游标持有物品');
      need(a.source.slot!==a.destinationSlot && !b.inventory.slots[a.destinationSlot],'DESTINATION_OCCUPIED','目标必须是另一个空的背包槽');
      const item = resolveSlot(b,a.source), expected = itemFingerprint(item);
      await b.moveSlotItem(item.slot,a.destinationSlot); c.check();
      need(!b.inventory.selectedItem && b.inventory.slots[a.destinationSlot] && itemFingerprint(b.inventory.slots[a.destinationSlot]!)===expected,'INVENTORY_MISMATCH','整理后的槽位与预期不同');
      return { evidence:'client_inventory_slot', slot:a.destinationSlot, item:itemDetails(b.inventory.slots[a.destinationSlot]) };
    }
    case 'furnace_inspect': case 'furnace_put': case 'furnace_take': {
      const block = h.block(a.position);
      need(['furnace','blast_furnace','smoker'].includes(block.name),'NOT_FURNACE','目标不是熔炉、高炉或烟熏炉');
      return withWindow(b,c,()=>b.openFurnace(block),async w=> {
        const state = () => ({ input:itemDetails(w.inputItem()), fuel:itemDetails(w.fuelItem()), output:itemDetails(w.outputItem()), progress:w.progress, fuelRemaining:w.fuel });
        if (a.type==='furnace_inspect') return { evidence:'client_window', ...state() };
        if (a.type==='furnace_put') {
          const before = amount(b,a.item); need(before>=a.count,'INSUFFICIENT_ITEMS','背包数量不足');
          await (a.slot==='input' ? w.putInput(typeOf(b,a.item),null,a.count) : w.putFuel(typeOf(b,a.item),null,a.count)); c.check();
          const removed = before-amount(b,a.item); need(removed===a.count,'INVENTORY_MISMATCH','装入数量不符');
          return { evidence:'inventory_delta', removed, ...state(), smeltingComplete:false };
        }
        const peek = () => a.slot==='input' ? w.inputItem() : a.slot==='fuel' ? w.fuelItem() : w.outputItem();
        await until(c,w,['updateSlot','update'],()=> {
          const item = peek();
          if (item && item.name!==a.expectedItem) throw new ActionError('UNEXPECTED_ITEM','熔炉槽位中的物品与预期不同');
          return !!item && item.count>=a.minCount;
        }); c.check();
        const selected = peek()!, expected = selected.count, before = matchingAmount(b,selected);
        await (a.slot==='input' ? w.takeInput() : a.slot==='fuel' ? w.takeFuel() : w.takeOutput()); c.check();
        const gained = matchingAmount(b,selected)-before; need(gained>=expected,'INVENTORY_MISMATCH','取出后的数量不足');
        return { evidence:'inventory_delta', gained, item:a.expectedItem, ...state() };
      });
    }
    case 'brewing_inspect': case 'brewing_put': case 'brewing_take': {
      need(b.version==='1.21.6','VERSION_MISMATCH','当前酿造槽位适配仅核对了 Java 1.21.6');
      const block = h.block(a.position); need(block.name==='brewing_stand','NOT_BREWING_STAND','目标不是酿造台');
      const source = a.type==='brewing_put' ? resolveSlot(b,a.source) : null;
      return withWindow(b,c,async()=>await b.openBlock(block) as Awaited<ReturnType<Bot['openBlock']>> & WindowLike,async w=> {
        need(w.type==='minecraft:brewing_stand' && w.inventoryStart===5,'WINDOW_MISMATCH','酿造窗口类型或槽位布局与适配版本不同');
        const state = () => w.slots.slice(0,5).map((item,slot)=>({slot,item:itemDetails(item),fingerprint:item ? itemFingerprint(item) : null}));
        if (a.type==='brewing_inspect') return { evidence:'client_window', slots:state(), brewingProgress:'unknown', fuelRemaining:'unknown' };
        need(!w.selectedItem,'CURSOR_OCCUPIED','鼠标游标持有物品');
        if (a.type==='brewing_put') {
          const item = windowItem(b,source!);
          need(!w.slots[a.destinationSlot],'DESTINATION_OCCUPIED','酿造目标槽必须为空');
          if (a.destinationSlot<=2) need(['potion','splash_potion','lingering_potion','glass_bottle'].includes(item.name) && item.count===1,'INVALID_BOTTLE','瓶子槽需要一个药水瓶或玻璃瓶');
          if (a.destinationSlot===4) need(item.name==='blaze_powder','INVALID_FUEL','酿造燃料槽只接收烈焰粉');
          const before = matchingAmount(b,item), expected = item.count;
          await b.moveSlotItem(item.slot,a.destinationSlot); c.check();
          need(before-matchingAmount(b,item)===expected,'INVENTORY_MISMATCH','酿造装入后的背包变化不符');
          return { evidence:'inventory_delta', removed:expected, slots:state(), potionCompleted:false };
        }
        const item = w.slots[a.slot];
        need(item && itemFingerprint(item)===a.fingerprint,'STALE_ITEM','酿造槽位已改变，请重新检查药水组件');
        const before = matchingAmount(b,item), expected = item.count;
        await b.putAway(a.slot); c.check();
        const gained = matchingAmount(b,item)-before;need(gained>=expected,'INVENTORY_MISMATCH','酿造取出后的物品组件或数量不符');
        return { evidence:'inventory_delta', gained, item:itemDetails(item), slots:state(), potionRecipeConfirmed:false };
      });
    }
    case 'trade_inspect': case 'trade': {
      const entity = h.entity(a.entityId); h.near(entity.position,3);
      need(entity.name==='villager','NOT_VILLAGER','当前封装仅支持普通村民');
      return withWindow(b,c,()=>b.openVillager(entity),async w=> {
        if (a.type==='trade_inspect') return { evidence:'client_trade_offers', offers:w.trades.map(t=>({...offerDetails(t),fingerprint:offerKey(t)})) };
        const candidates = w.trades.map((t,index)=>({t,index})).filter(({t})=>offerKey(t)===a.offerFingerprint);
        need(candidates.length===1,'STALE_OFFER','报价已改变或不唯一，请重新读取交易');
        const { t, index } = candidates[0];
        need(!t.tradeDisabled && t.maximumNbTradeUses-t.nbTradeUses>=a.repetitions,'TRADE_UNAVAILABLE','交易已锁定或次数不足');
        need(matchingAmount(b,t.inputItem1)>=(t.realPrice ?? t.inputItem1.count)*a.repetitions,'INSUFFICIENT_ITEMS','第一种交易材料不足');
        if (t.hasItem2) need(t.inputItem2 && matchingAmount(b,t.inputItem2)>=t.inputItem2.count*a.repetitions,'INSUFFICIENT_ITEMS','第二种交易材料不足');
        need(itemIdentity(t.outputItem)!==itemIdentity(t.inputItem1) && (!t.inputItem2 || itemIdentity(t.outputItem)!==itemIdentity(t.inputItem2)),'UNSUPPORTED','输入与输出相同的自定义交易不支持增量验证');
        const before = matchingAmount(b,t.outputItem);
        await b.trade(w,index,a.repetitions); c.check();
        const gained = matchingAmount(b,t.outputItem)-before;
        need(gained===t.outputItem.count*a.repetitions,'INVENTORY_MISMATCH','交易产物或组件不符合报价');
        return { evidence:'inventory_delta', gained, output:itemDetails(t.outputItem), resolvedIndex:index };
      });
    }
    case 'enchant': {
      const block = h.block(a.position); need(block.name==='enchanting_table','NOT_ENCHANTING_TABLE','目标不是附魔台');
      const target = resolveSlot(b,a.target);
      need(a.choice+1<=a.maxLevelCost,'BUDGET_EXCEEDED','选项的等级消耗超过预算');
      return withWindow(b,c,()=>b.openEnchantmentTable(block),async w=> {
        const targetInWindow = windowItem(b,target);
        const lapis = inventory(b).find(i=>i.name==='lapis_lazuli' && i.count>=a.choice+1);
        need(lapis,'INSUFFICIENT_LAPIS','缺少足够的青金石');
        await w.putTargetItem(targetInWindow); c.check();
        // Resolve again: moving the target can update other window slots.
        const currentLapis = inventory(b).find(i=>i.name==='lapis_lazuli' && i.count>=a.choice+1);
        need(currentLapis,'INSUFFICIENT_LAPIS','青金石发生变化');
        await w.putLapis(currentLapis!); c.check();
        await until(c,w,['ready'],()=>w.enchantments.every(e=>e.level>=0)); c.check();
        const offer = w.enchantments[a.choice];
        need(offer.level>0 && b.experience.level>=offer.level,'INSUFFICIENT_LEVEL','未达到附魔选项的显示等级要求');
        const enchanted = await w.enchant(a.choice); c.check();
        need(enchanted && enchanted.enchants.length>0,'ENCHANTMENT_UNCONFIRMED','没有读到实际附魔');
        await w.takeTargetItem(); c.check();
        need(matchingAmount(b,enchanted)>=1,'INVENTORY_MISMATCH','没有在背包中找到附魔后的物品');
        return { evidence:'client_item_enchantments', item:itemDetails(enchanted), requiredLevel:offer.level, levelCost:a.choice+1 };
      });
    }
    case 'anvil': {
      const block = h.block(a.position); need(['anvil','chipped_anvil','damaged_anvil'].includes(block.name),'NOT_ANVIL','目标不是铁砧');
      const target = resolveSlot(b,a.target), second = a.second ? resolveSlot(b,a.second) : null;
      need(second || a.rename,'INVALID_OPERATION','没有第二物品时必须指定重命名');
      need(!second || second.slot!==target.slot,'INVALID_OPERATION','两个输入不能是同一槽');
      // Native anvil.transfer matches type/metadata/NBT, not modern components or our slotRef.
      // Refuse ambiguous same-type stacks instead of silently modifying the wrong enchanted tool.
      for (const selected of [target,second].filter((i): i is Item=>!!i)) {
        need(inventory(b).filter(i=>i.type===selected.type && i.metadata===selected.metadata && fingerprint(i.nbt)===fingerprint(selected.nbt)).length===1,
          'AMBIGUOUS_NATIVE_ITEM','原生铁砧无法可靠区分同类物品，请先整理到唯一候选');
      }
      const ctor = target.constructor as unknown as { anvil(a: Item, b: Item | null, creative: boolean, rename?: string): { xpCost:number; item:Item | null } };
      const normal = ctor.anvil(target,second,false,a.rename);
      const inverse = second ? ctor.anvil(second,target,false,a.rename) : normal;
      // Mineflayer chooses order by its own anvil cost comparison; mirror it for budget checking.
      const predicted = !second || inverse.xpCost===0 || (normal.xpCost>0 && normal.xpCost<inverse.xpCost) ? normal : inverse;
      need(predicted.item && predicted.xpCost>0,'INVALID_OPERATION','物品不能按该方式加工');
      need(predicted.xpCost<=a.maxLevelCost && b.experience.level>=predicted.xpCost,'BUDGET_EXCEEDED','铁砧等级消耗超过预算或当前等级');
      const before = inventory(b).map(itemFingerprint);
      // Mineflayer's public Anvil declaration omits Window methods present at runtime.
      return withWindow(b,c,async()=>await b.openAnvil(block) as Awaited<ReturnType<Bot['openAnvil']>> & WindowLike,async w=> {
        const currentTarget = windowItem(b,target), currentSecond = second ? windowItem(b,second) : null;
        if (currentSecond) await w.combine(currentTarget,currentSecond,a.rename); else await w.rename(currentTarget,a.rename!);
        c.check();
        const changed = inventory(b).filter(i=>!before.includes(itemFingerprint(i)) && i.name===predicted.item!.name);
        need(changed.some(i=> i.durabilityUsed===predicted.item!.durabilityUsed && fingerprint(i.enchants)===fingerprint(predicted.item!.enchants)
          && (!a.rename || JSON.stringify(i.customName).includes(a.rename))), 'INVENTORY_MISMATCH','铁砧产物的耐久、附魔或名称不符合预期');
        return { evidence:'client_inventory_changed', items:changed.map(itemDetails), estimatedLevelCost:predicted.xpCost, exactComponentsConfirmed:false };
      });
    }
    case 'fish_once': {
      need(b.heldItem?.name==='fishing_rod','MISSING_FISHING_ROD','请先装备鱼竿并看向水面');
      const before = new Map(inventory(b).map(i=>[i.name,amount(b,i.name)]));
      let completed = false;
      // Fishing has no public cancel method. Reel in on abort, then retain the lease until its native task settles.
      c.cleanup(()=> { if (!completed) b.activateItem(); });
      await b.fish(); completed = true; c.check();
      const names = [...new Set(inventory(b).map(i=>i.name))];
      return { evidence:'native_fishing_cycle_completed', observedGains:names.map(name=>({name,count:amount(b,name)-(before.get(name) ?? 0)})).filter(i=>i.count>0), catchCollectedConfirmed:false };
    }
    case 'mount': {
      const entity = h.entity(a.entityId); h.near(entity.position,3);
      need(allowVehicle(entity.name),'UNSUPPORTED','仅封装普通船/竹筏，其他载具需要专用控制器');
      need(!b.vehicle,'ALREADY_MOUNTED','当前已乘坐载具');
      await until(c,b,['mount','physicsTick'],()=>b.vehicle?.id===entity.id,()=>b.mount(entity));
      return { evidence:'client_vehicle_relation', vehicleId:entity.id, driverSeatConfirmed:false };
    }
    case 'vehicle_control': {
      const vehicle = b.vehicle; need(vehicle && allowVehicle(vehicle.name),'UNSUPPORTED','仅封装已乘坐普通船/竹筏的水平输入');
      const drive = () => { if (b.vehicle?.id===vehicle.id) b.moveVehicle(a.left,a.forward); };
      c.cleanup(()=>{ b.removeListener('physicsTick',drive); b.moveVehicle(0,0); });
      b.on('physicsTick',drive); drive();
      let elapsed = 0;
      const increment = () => { elapsed++; };
      b.on('physicsTick',increment);
      try { await until(c,b,['physicsTick','dismount'],()=> { need(b.vehicle?.id===vehicle.id,'VEHICLE_LOST','乘坐关系已改变'); return elapsed>=a.ticks; }); }
      finally { b.removeListener('physicsTick',increment); }
      return { evidence:'client_physics_ticks', ticks:elapsed, position:plain(b.entity.position), routeComplete:false };
    }
    case 'dismount': {
      need(b.vehicle,'NOT_MOUNTED','当前没有乘坐载具');
      // 1.21.6's native branch sends jump:true; do not pretend this is a verified dismount.
      need(!b.supportFeature('newPlayerInputPacket'),'UNSUPPORTED','当前 Mineflayer 新输入包分支的下乘语义未验证');
      await until(c,b,['dismount','physicsTick'],()=>!b.vehicle,()=>b.dismount());
      return { evidence:'client_vehicle_relation', dismounted:true, safeLandingConfirmed:false };
    }
    case 'say': {
      need(!/[\r\n\u0000-\u001f]/u.test(a.message) && !/^[\/!{[]/.test(a.message) && !/[{}]|\b(?:bot\.|execute\s*\(|attack_once|container_transfer|navigation\.goto)/i.test(a.message),'INVALID_CHAT','聊天仅允许自然语言，不接受命令、工具 JSON 或调用代码');
      b.chat(a.message); return { evidence:'chat_sent', deliveredConfirmed:false };
    }
    default: throw new ActionError('UNSUPPORTED',`没有实现动作 ${a.type}`);
  }
}
