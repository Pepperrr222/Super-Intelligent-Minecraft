import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { itemFingerprint } from '../src/observation.js';
import { fixture, makeItem, tick } from './fixtures.js';
const position={x:0,y:0,z:1};

test('physics-tick controls wait for real events and release inputs',async()=>{
  const {bot,actions}=fixture(); let clears=0;
  bot.clearControlStates=()=>clears++;
  const p=actions.execute({type:'move_ticks',controls:['forward'],ticks:2});await tick();
  assert.equal(actions.busy,true);bot.emit('physicsTick');await tick();assert.equal(actions.busy,true);
  bot.emit('physicsTick');assert.equal((await p).status,'succeeded');assert.equal(clears,1);
  assert.equal(bot.listenerCount('physicsTick'),1); // observation clock only
  actions.dispose();assert.equal(bot.listenerCount('physicsTick'),0);
});
test('tick hold timeout releases item and listeners',async()=>{
  const {bot,actions}=fixture();bot.heldItem=makeItem('bow');let released=0;bot.deactivateItem=()=>released++;
  const r=await actions.execute({type:'use_item_ticks',ticks:20},{timeoutMs:10});
  assert.equal(r.status,'timed_out');assert.equal(released,1);assert.equal(bot.listenerCount('physicsTick'),1);actions.dispose();
});
test('player attack and nearby sweep risk are rejected before attack',async()=>{
  const {bot,actions}=fixture();bot.attack=()=>assert.fail('must not attack');
  bot.entities[1]={id:1,name:'player',position:new Vec3(1,0,0)};
  assert.equal((await actions.execute({type:'attack_once',entityId:1})).error?.code,'PLAYER_DAMAGE_RISK');
  bot.entities[2]={id:2,name:'zombie',position:new Vec3(2,0,0)};
  assert.equal((await actions.execute({type:'attack_once',entityId:2})).error?.code,'PLAYER_DAMAGE_RISK');actions.dispose();
});
test('public snapshot bounds entities and unknown block is not air',()=>{
  const {bot,actions}=fixture();bot.blockAt=()=>null;
  bot.entities[1]={id:1,position:new Vec3(100,0,0)};
  assert.equal(actions.observe().entities.length,0);
  const q:any=actions.query({type:'verify',condition:{kind:'block_is',position,name:'air'}});
  assert.equal(q.data.value,'unknown');
  assert.equal((actions.query({type:'verify',condition:{kind:'entity_near',entityId:99,distance:3}}) as any).data.value,'unknown');
  actions.dispose();
});
test('query fingerprints distinguish components of same-name items',()=>{
  const {actions,slots}=fixture();slots[9]=makeItem('diamond_pickaxe',1,9);slots[10]=makeItem('diamond_pickaxe',1,10);
  slots[10]!.enchants=[{name:'silk_touch',lvl:1}];
  const items=actions.observe().inventory;
  assert.notEqual(items[0].fingerprint,items[1].fingerprint);actions.dispose();
});
test('wait_until observes property changes and cancellation cleans listeners',async()=>{
  const {bot,actions}=fixture();let lit=false;
  bot.blockAt=(p:Vec3)=>({name:'furnace',position:p,getProperties:()=>({lit})});
  const p=actions.execute({type:'wait_until',condition:{kind:'block_is',position,name:'furnace',properties:{lit:true}}});await tick();
  lit=true;bot.emit('blockUpdate');assert.equal((await p).status,'succeeded');
  lit=false;const p2=actions.execute({type:'wait_until',condition:{kind:'block_is',position,name:'furnace',properties:{lit:true}}});await tick();actions.stop();
  assert.equal((await p2).status,'cancelled');assert.equal(bot.listenerCount('blockUpdate'),0);actions.dispose();
});
test('craft output converts requested count to recipe repetitions',async()=>{
  const {bot,slots,actions}=fixture();let repetitions=0;
  bot.recipesFor=()=>[{result:{count:4}}];bot.craft=async(_:unknown,n:number)=>{repetitions=n;slots[9]=makeItem('oak_planks',n*4);};
  const r=await actions.execute({type:'craft_output',item:'oak_planks',outputCount:5});
  assert.equal(r.status,'succeeded');assert.equal(repetitions,2);assert.equal((r.data as any).gained,8);actions.dispose();
});
test('furnace puts use GUI inventory rather than stale bot inventory',async()=>{
  const {bot,slots,window,actions}=fixture();slots[9]=makeItem('raw_iron',4);let w:any;
  bot.openFurnace=async()=>{
    w=window('minecraft:furnace');w.inputItem=()=>w.slots[0];w.fuelItem=()=>null;w.outputItem=()=>null;
    w.putInput=async(_:number,__:unknown,n:number)=>{w.slots[3].count-=n;w.slots[0]=makeItem('raw_iron',n,0);};return w;
  };
  const r=await actions.execute({type:'furnace_put',position,slot:'input',item:'raw_iron',count:2});
  assert.equal(r.status,'succeeded');assert.equal((r.data as any).removed,2);assert.equal(w.closed,1);assert.equal(slots[9]!.count,2);actions.dispose();
});
test('furnace_take waits for output events, takes entire stack and verifies inventory',async()=>{
  const {bot,window,actions}=fixture();let w:any;
  bot.openFurnace=async()=>{w=window('minecraft:furnace');w.inputItem=w.fuelItem=()=>null;w.outputItem=()=>w.slots[2];
    w.takeOutput=async()=>{const i=w.slots[2];w.slots[3]=makeItem(i.name,i.count,3);w.slots[2]=null;return i;};return w;};
  const p=actions.execute({type:'furnace_take',position,slot:'output',expectedItem:'iron_ingot',minCount:2});await tick();
  w.slots[2]=makeItem('iron_ingot',3,2);w.emit('update');const r=await p;
  assert.equal(r.status,'succeeded');assert.equal((r.data as any).gained,3);assert.equal(w.closed,1);assert.equal(w.listenerCount('update'),0);actions.dispose();
});
test('late furnace window closes after cancellation without loading input',async()=>{
  const {bot,window,actions}=fixture();let resolve!:(w:any)=>void;
  bot.openFurnace=()=>new Promise(r=>resolve=r);
  const p=actions.execute({type:'furnace_put',position,slot:'input',item:'raw_iron',count:1});await tick();actions.stop();
  assert.equal((await p).status,'cancelled');assert.equal(actions.busy,true);
  const w=window('minecraft:furnace');w.putInput=()=>assert.fail('must not load');resolve(w);await tick();
  assert.equal(w.closed,1);assert.equal(actions.busy,false);actions.dispose();
});
test('unexpected GUI from a rejected native opener is closed',async()=>{
  const {bot,window,actions}=fixture();let w:any;
  bot.openFurnace=async()=>{w=window('minecraft:generic_9x3');throw new Error('wrong window');};
  assert.equal((await actions.execute({type:'furnace_inspect',position})).status,'failed');assert.equal(w.closed,1);actions.dispose();
});
test('trade resolves fresh offer index by terms and rejects price changes',async()=>{
  const {bot,slots,window,actions}=fixture();slots[9]=makeItem('emerald',10);
  bot.entities[1]={id:1,name:'villager',position:new Vec3(1,0,0)};
  const offer=()=>({inputItem1:makeItem('emerald',1),inputItem2:null,hasItem2:false,outputItem:makeItem('bread',2),realPrice:1,tradeDisabled:false,nbTradeUses:0,maximumNbTradeUses:10});
  let terms=offer(), extra=false, traded=0;
  bot.openVillager=async()=>{const w=window('minecraft:merchant');w.trades=extra ? [{...offer(),outputItem:makeItem('apple')},terms] : [terms];return w;};
  bot.trade=async(w:any,index:number,n:number)=>{assert.equal(index,1);traded++;w.slots[3].count-=n;w.slots[4]=makeItem('bread',2*n,4);};
  const inspection=await actions.execute({type:'trade_inspect',entityId:1});const key=(inspection.data as any).offers[0].fingerprint;
  extra=true;assert.equal((await actions.execute({type:'trade',entityId:1,offerFingerprint:key,repetitions:2})).status,'succeeded');
  terms={...terms,realPrice:2};assert.equal((await actions.execute({type:'trade',entityId:1,offerFingerprint:key,repetitions:1})).error?.code,'STALE_OFFER');assert.equal(traded,1);actions.dispose();
});
test('trade verifies second input before issuing transaction',async()=>{
  const {bot,slots,window,actions}=fixture();slots[9]=makeItem('emerald',10);bot.entities[1]={id:1,name:'villager',position:new Vec3(1,0,0)};
  bot.openVillager=async()=>{const w=window('minecraft:merchant');w.trades=[{inputItem1:makeItem('emerald'),inputItem2:makeItem('book'),hasItem2:true,outputItem:makeItem('enchanted_book'),realPrice:1,tradeDisabled:false,nbTradeUses:0,maximumNbTradeUses:10}];return w;};
  bot.trade=()=>assert.fail('missing second input');
  const inspection=await actions.execute({type:'trade_inspect',entityId:1});
  const r=await actions.execute({type:'trade',entityId:1,offerFingerprint:(inspection.data as any).offers[0].fingerprint,repetitions:1});
  assert.equal(r.error?.code,'INSUFFICIENT_ITEMS');actions.dispose();
});
test('enchant remaps inventory slot, checks real offer level and returns actual enchantment',async()=>{
  const {bot,slots,window,actions}=fixture();slots[9]=makeItem('diamond_pickaxe');slots[10]=makeItem('lapis_lazuli',3,10);
  bot.blockAt=(p:Vec3)=>({name:'enchanting_table',position:p});let targetSlot=-1;
  bot.openEnchantmentTable=async()=>{
    const w=window('minecraft:enchantment',2);w.enchantments=[{level:1},{level:10},{level:30}];
    w.putTargetItem=async(i:any)=>{targetSlot=i.slot;w.slots[0]=i;w.slots[i.slot]=null;};
    w.putLapis=async(i:any)=>{w.slots[1]=i;w.slots[i.slot]=null;};
    w.enchant=async()=>{w.slots[0].enchants=[{name:'efficiency',lvl:3}];return w.slots[0];};
    w.takeTargetItem=async()=>{w.slots[2]=w.slots[0];w.slots[0]=null;};return w;
  };
  const r=await actions.execute({type:'enchant',position,target:{slot:9,fingerprint:itemFingerprint(slots[9]!)},choice:2,maxLevelCost:3});
  assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(targetSlot,2);assert.equal((r.data as any).levelCost,3);assert.equal((r.data as any).requiredLevel,30);actions.dispose();
});
test('enchant stale ref is rejected before opening GUI',async()=>{
  const {bot,slots,actions}=fixture();slots[9]=makeItem('diamond_pickaxe');bot.blockAt=(p:Vec3)=>({name:'enchanting_table',position:p});
  bot.openEnchantmentTable=()=>assert.fail('stale item');
  assert.equal((await actions.execute({type:'enchant',position,target:{slot:9,fingerprint:'0'.repeat(64)},choice:0,maxLevelCost:1})).error?.code,'STALE_ITEM');actions.dispose();
});
test('anvil validates budget and rejects ambiguous component-based selection',async()=>{
  const {bot,slots,actions}=fixture();slots[9]=makeItem('diamond_pickaxe');slots[10]=makeItem('diamond_pickaxe',1,10);
  (slots[10] as any).components=[{type:'enchantments',data:{silk_touch:1}}];
  bot.blockAt=(p:Vec3)=>({name:'anvil',position:p});bot.openAnvil=()=>assert.fail('ambiguous input');
  const r=await actions.execute({type:'anvil',position,target:{slot:9,fingerprint:itemFingerprint(slots[9]!)},rename:'工具',maxLevelCost:1});
  assert.equal(r.error?.code,'AMBIGUOUS_NATIVE_ITEM');actions.dispose();
});
test('fishing cancellation reels in and retains lease until native promise settles',async()=>{
  const {bot,actions}=fixture();bot.heldItem=makeItem('fishing_rod');let release!:()=>void,reels=0;
  bot.fish=()=>new Promise<void>(r=>release=r);bot.activateItem=()=>reels++;
  const p=actions.execute({type:'fish_once'});await tick();actions.stop();assert.equal((await p).status,'cancelled');assert.equal(reels,1);assert.equal(actions.busy,true);
  release();await tick();assert.equal(actions.busy,false);actions.dispose();
});
test('boat control sends every tick and neutralizes on stop; modern dismount is explicit gap',async()=>{
  const {bot,actions}=fixture();bot.vehicle={id:2,name:'oak_boat'};const controls:number[][]=[];bot.moveVehicle=(l:number,f:number)=>controls.push([l,f]);
  const p=actions.execute({type:'vehicle_control',left:0,forward:1,ticks:10});await tick();bot.emit('physicsTick');actions.stop();
  assert.equal((await p).status,'cancelled');assert.deepEqual(controls.at(-1),[0,0]);assert.equal(controls.length,3);
  await tick();
  assert.equal((await actions.execute({type:'dismount'})).error?.code,'UNSUPPORTED');actions.dispose();
});
test('anvil rename checks level budget and verifies returned item',async()=>{
  const {bot,slots,window,actions}=fixture();slots[9]=makeItem('diamond_pickaxe');
  bot.blockAt=(p:Vec3)=>({name:'anvil',position:p});let opened=0;
  bot.openAnvil=async()=>{opened++;const w=window('minecraft:anvil');
    w.rename=async(i:any,name:string)=>{const prediction=i.constructor.anvil(i,null,false,name);w.slots[3]=prediction.item;w.slots[3].slot=3;};return w;};
  const request={type:'anvil',position,target:{slot:9,fingerprint:itemFingerprint(slots[9]!)},rename:'My Pickaxe',maxLevelCost:1};
  bot.experience.level=0;assert.equal((await actions.execute(request)).error?.code,'BUDGET_EXCEEDED');assert.equal(opened,0);
  bot.experience.level=10;const result=await actions.execute(request);assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(opened,1);actions.dispose();
});
test('chat rejects commands and JSON while sending ordinary text',async()=>{
  const {bot,actions}=fixture();const sent:string[]=[];bot.chat=(s:string)=>sent.push(s);
  for(const message of ['/give me diamond','!attackPlayer bob','{"type":"dig"}','bot.attack(x)']) assert.equal((await actions.execute({type:'say',message})).status,'failed');
  assert.equal((await actions.execute({type:'say',message:'铁锭已经做好了。'})).status,'succeeded');assert.equal(sent.length,1);actions.dispose();
});
test('dimension transition aborts old controls',async()=>{
  const {bot,actions}=fixture();const p=actions.execute({type:'wait_ticks',ticks:10});await tick();bot.game.dimension='the_nether';bot.emit('game');
  assert.equal((await p).status,'cancelled');actions.dispose();
});
test('dimension condition survives transition and observes new dimension',async()=>{
  const {bot,actions}=fixture();const p=actions.execute({type:'wait_until',condition:{kind:'dimension_is',dimension:'the_nether'}});await tick();
  bot.game.dimension='the_nether';bot.emit('game');assert.equal((await p).status,'succeeded');actions.dispose();
});
test('brewing rejects unverified versions and unexpected window layouts',async()=>{
  const {bot,window,actions}=fixture();let opened=0, w:any;
  bot.blockAt=(p:Vec3)=>({name:'brewing_stand',position:p});bot.openBlock=async()=>{opened++;w=window('minecraft:generic_9x3',27);return w;};
  bot.version='1.21.4';assert.equal((await actions.execute({type:'brewing_inspect',position})).error?.code,'VERSION_MISMATCH');assert.equal(opened,0);
  bot.version='1.21.6';assert.equal((await actions.execute({type:'brewing_inspect',position})).error?.code,'WINDOW_MISMATCH');assert.equal(w.closed,1);actions.dispose();
});
test('brewing remaps exact bottle slot and preserves component fingerprint',async()=>{
  const {bot,slots,window,actions}=fixture();slots[9]=makeItem('potion');(slots[9] as any).components=[{type:'potion_contents',data:{potion:'water'}}];
  bot.blockAt=(p:Vec3)=>({name:'brewing_stand',position:p});let w:any,sourceSlot=-1;
  bot.openBlock=async()=>{w=window('minecraft:brewing_stand',5);return w;};
  bot.moveSlotItem=async(src:number,dest:number)=>{sourceSlot=src;w.slots[dest]=w.slots[src];w.slots[src]=null;};
  const result=await actions.execute({type:'brewing_put',position,source:{slot:9,fingerprint:itemFingerprint(slots[9]!)},destinationSlot:0});
  assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(sourceSlot,5);assert.equal((result.data as any).potionCompleted,false);actions.dispose();
});
test('brewing_take refuses changed potion even if base item name matches',async()=>{
  const {bot,window,actions}=fixture();const old=makeItem('potion');const key=itemFingerprint(old);
  bot.blockAt=(p:Vec3)=>({name:'brewing_stand',position:p});bot.openBlock=async()=>{const w=window('minecraft:brewing_stand',5);w.slots[0]=makeItem('potion');w.slots[0].components=[{type:'potion_contents',data:{potion:'poison'}}];return w;};
  bot.putAway=()=>assert.fail('must not take changed bottle');
  assert.equal((await actions.execute({type:'brewing_take',position,slot:0,fingerprint:key})).error?.code,'STALE_ITEM');actions.dispose();
});
test('container transfer verifies live GUI inventory before close copies back',async()=>{
  const {bot,slots,window,actions}=fixture();slots[9]=makeItem('dirt',8);let w:any;
  bot.openContainer=async()=>{w=window('minecraft:generic_9x3',27);w.deposit=async(_:number,__:unknown,n:number)=>{w.slots[27].count-=n;};return w;};
  const result=await actions.execute({type:'container_transfer',position,direction:'deposit',item:'dirt',count:3});
  assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(slots[9]!.count,5);actions.dispose();
});
test('mount waits for the observed passenger relation instead of packet dispatch',async()=>{
  const {bot,actions}=fixture();bot.entities[1]={id:1,name:'oak_boat',position:new Vec3(1,0,0)};bot.mount=()=>{};
  const pending=actions.execute({type:'mount',entityId:1});await tick();assert.equal(actions.busy,true);
  bot.vehicle=bot.entities[1];bot.emit('mount');const r=await pending;assert.equal(r.status,'succeeded');assert.equal((r.data as any).driverSeatConfirmed,false);actions.dispose();
});
test('entity hit offset is converted to world position for Mineflayer',async()=>{
  const {bot,actions}=fixture();bot.entities[1]={id:1,height:2,position:new Vec3(1,0,0)};let point:Vec3|undefined;
  bot.activateEntityAt=async(_:unknown,p:Vec3)=>{point=p;};
  assert.equal((await actions.execute({type:'activate_entity_at',entityId:1,offset:{x:0,y:1,z:0}})).status,'succeeded');assert.deepEqual(point,new Vec3(1,1,0));actions.dispose();
});
