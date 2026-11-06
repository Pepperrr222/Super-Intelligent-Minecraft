import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { fixture, makeItem, tick } from './fixtures.js';
import { craftingOptions, recipeGroups, recipeHandle, resolveRecipeHandle } from '../src/crafting-knowledge.js';
import { ContainerMemory } from '../src/resource-memory.js';
import { itemDetails } from '../src/observation.js';
import { knowledgeQuerySchema } from '../src/schema.js';
import { recipeReference, type RecipeProvider, type RecipeRecord } from '../src/recipes.js';
import { bindOperation } from '../src/operation-gateway.js';
const require = createRequire(import.meta.url), native = createRequire(require.resolve('mineflayer'));
function setup() {
  const f = fixture('1.21.1');
  const { Recipe } = native('prismarine-recipe')(f.bot.registry);
  let lookups = 0;
  f.bot.recipesAll = (id:number, metadata:number|null) => { lookups++; return Recipe.find(id,metadata); };
  return {...f, lookups:()=>lookups};
}
const params = (goals:any[], rest = {}) => {
  const parsed = knowledgeQuerySchema.parse({type:'crafting_options',goals,...rest});
  if (parsed.type !== 'crafting_options') throw new Error('wrong test input');
  return parsed;
};
test('one crafting query supplies exact handles, shared dependencies and compact groups without pagination', () => {
  const {actions,slots,lookups} = setup();
  slots[9] = makeItem('spruce_log',3);
  const result:any = actions.query({type:'crafting_options',goals:[{item:'wooden_pickaxe',count:1}]});
  assert.equal(result.status,'succeeded');
  assert.equal(result.data.dependencies.status,'resolved');
  assert.equal(result.data.materialsReady,false);
  assert.ok(result.data.goals[0].groups.length < result.data.goals[0].alternativesTotal);
  assert.equal(result.data.facilityObserved,false);
  const ops = result.data.dependencies.operations.filter((op:any)=>op.kind==='craft');
  assert.ok(ops.every((op:any)=>op.recipeRef.startsWith('recipe:')));
  for (const op of ops) assert.equal(resolveRecipeHandle(actions.observations.recipes,op.item,op.recipeRef).result.item,op.item);
  const before = lookups();
  actions.query({type:'crafting_options',goals:[{item:'wooden_pickaxe',count:1}]});
  assert.equal(lookups(),before);
  actions.dispose();
});
test('cached knowledge does not cache inventory readiness; short handles bind product and version', () => {
  const {actions,slots,bot} = setup();
  const q = {type:'crafting_options',goals:[{item:'spruce_planks',count:4}],includeDependencies:false};
  assert.equal((actions.query(q) as any).data.materialsReady,false);
  slots[9] = makeItem('spruce_log',1);
  const result:any = actions.query(q), ref = result.data.goals[0].allocation;
  assert.equal(result.data.materialsReady,true);
  const action:any = bindOperation({type:'craft',item:'spruce_planks',count:4,recipeRef:ref},actions.observations,bot);
  assert.match(action.recipeRef,/^[a-f0-9]{64}$/);
  assert.throws(()=>resolveRecipeHandle(actions.observations.recipes,'stick',ref),/不属于/);
  bot.version = 'changed';
  assert.throws(()=>resolveRecipeHandle(actions.observations.recipes,'spruce_planks',ref),/不属于/);
  actions.dispose();
});
test('multi-goal material accounting cannot allocate one stock twice and preserves rounding leftovers', () => {
  const {actions} = setup(), provider = actions.observations.recipes;
  const result = craftingOptions(provider,params([{item:'wooden_pickaxe',count:1},{item:'wooden_axe',count:1}],{includeDependencies:false}),
    [{item:'spruce_planks',count:3},{item:'stick',count:4}]);
  assert.equal(result.goals[0]!.materialsReady,true); assert.equal(result.goals[1]!.materialsReady,false);
  const rounded = craftingOptions(provider,params([{item:'stick',count:3}],{mode:'additional'}),[{item:'spruce_planks',count:2}]);
  assert.equal(rounded.goals[0]!.alternatives[0]!.outputCount,4);
  assert.equal(rounded.dependencies!.inventoryRemaining.find(i=>i.item==='stick')!.count,1);
  actions.dispose();
});
test('derived material groups never invent mixed recipes or advertise arbitrary tag membership', () => {
  const record = (wood:string):RecipeRecord => {
    const base = {source:'fixture',version:'1',revision:'1',kind:'crafting' as const,result:{item:'tool',count:1},facility:'inventory' as const,
      ingredients:[{item:wood,count:3},{item:'stick',count:2}]};
    return {...base,recipeRef:recipeReference(base)};
  };
  const records = [record('oak_planks'),record('spruce_planks')];
  const provider:RecipeProvider = {source:'fixture',version:'1',revision:'1',lookup:()=>records};
  const inventory = [{item:'oak_planks',count:2},{item:'spruce_planks',count:1},{item:'stick',count:2}];
  const groups = recipeGroups(records,inventory,true);
  assert.equal(groups.length,1); assert.equal(groups[0]!.freelyMixable,false);
  assert.deepEqual(groups[0]!.ingredients[0]!.members,['oak_planks','spruce_planks']);
  assert.equal(craftingOptions(provider,params([{item:'tool',count:1}],{includeDependencies:false}),inventory).materialsReady,false);
});
test('special materials are excluded from automatic ordinary-material readiness', () => {
  const {actions,slots} = setup(); slots[9] = Object.assign(makeItem('spruce_log',3),{nbt:{custom:true}});
  const result:any = actions.query({type:'crafting_options',goals:[{item:'spruce_planks',count:4}]});
  assert.equal(result.data.materialsReady,false); assert.equal(result.data.excludedSpecialItems.length,1); actions.dispose();
});

test('a used tool counts as owned without becoming consumable stock or forcing another craft',()=>{
  const {actions,slots}=setup();
  slots[9]=Object.assign(makeItem('wooden_pickaxe',1),{nbt:{Damage:2}});
  const q={type:'crafting_options',goals:[{item:'wooden_pickaxe',count:1}],mode:'total'};
  const result:any=actions.query(q);
  assert.equal(result.data.goals[0].owned,1);assert.equal(result.data.goals[0].requested,0);
  assert.equal(result.data.materialsReady,true);assert.deepEqual(result.data.dependencies.operations,[]);
  assert.equal(result.data.dependencies.reservedExisting[0].item,'wooden_pickaxe');
  const additional:any=actions.query({...q,mode:'additional'});
  assert.equal(additional.data.goals[0].requested,1);assert.equal(additional.data.materialsReady,false);
  actions.dispose();
});
test('protected target stock cannot leak into another targets recursive ingredients',()=>{
  const {actions,slots}=setup();slots[9]=Object.assign(makeItem('spruce_planks',4),{nbt:{custom:true}});
  const result:any=actions.query({type:'crafting_options',goals:[{item:'spruce_planks',count:4},{item:'crafting_table',count:1}]});
  assert.equal(result.data.goals[0].requested,0);assert.equal(result.data.goals[1].materialsReady,false);
  assert.notEqual(result.data.dependencies.status,'resolved');actions.dispose();
});
test('craft preflight projects earlier crafts, rejects shared-stock overspend and mismatched products',()=>{
  const {actions,slots}=setup();slots[9]=makeItem('spruce_log',1);
  const p=actions.observations.recipes;
  const planks=recipeHandle(p.lookup('spruce_planks')[0]!);
  const stick=recipeHandle(p.lookup('stick').find(r=>r.ingredients.some(i=>i.item==='spruce_planks'))!);
  assert.equal(actions.observations.validateCrafts([
    {type:'craft',item:'spruce_planks',count:4,recipeRef:planks},
    {type:'craft',item:'stick',count:8,recipeRef:stick},
  ]),undefined);
  assert.match(actions.observations.validateCrafts([
    {type:'craft',item:'spruce_planks',count:4,recipeRef:planks},
    {type:'craft',item:'stick',count:12,recipeRef:stick},
  ])!,/材料不足/);
  assert.throws(()=>actions.observations.validateCrafts([{type:'craft',item:'stick',count:4,recipeRef:planks}]),/不属于/);
  actions.dispose();
});

test('target preflight rejects already-mined refs before model review, while allowing navigation then dig',()=>{
  const {actions,bot}=setup();let mined=false;
  bot.findBlocks=()=>[new Vec3(1,0,0)];
  bot.blockAt=(p:Vec3)=>({position:p,name:mined?'air':'stone',stateId:mined?0:1,getProperties:()=>({})});
  const r:any=actions.query({type:'observe_targets',names:['stone']});const ref=r.data.targets[0].ref;
  assert.doesNotThrow(()=>actions.observations.validateTargets([{type:'navigate',targetRef:ref,range:2},{type:'dig',targetRef:ref}]));
  assert.throws(()=>actions.observations.validateTargets([{type:'dig',targetRef:ref},{type:'dig',targetRef:ref}]),/DUPLICATE/);
  mined=true;assert.throws(()=>actions.observations.validateTargets([{type:'dig',targetRef:ref}]),/变化/);actions.dispose();
});

test('container transfer refreshes recorded contents and marks uncertainty on partial failure',async()=>{
  const {actions,bot,window}=setup();let fail=false;
  bot.openContainer=async()=>{
    const w=window('minecraft:generic_9x3',27);w.slots[0]=makeItem('spruce_log',6,0);
    w.withdraw=async(_type:number,_metadata:unknown,count:number)=>{
      w.slots[0].count-=count;w.slots[27]=makeItem('spruce_log',count,27);
      if(fail)throw new Error('partial transfer');
    };return w;
  };
  const transfer={type:'container_transfer',position:{x:1,y:0,z:0},direction:'withdraw',item:'spruce_log',count:2};
  assert.equal((await actions.execute(transfer)).status,'succeeded');
  assert.equal(actions.observations.containers.query().containers[0]!.slots[0]!.count,4);
  fail=true;assert.equal((await actions.execute(transfer)).status,'failed');
  assert.equal(actions.observations.containers.query().containers[0]!.status,'invalidated');actions.dispose();
});

test('decorated recipe ingredients cannot be consumed by name-only native crafting',async()=>{
  const {actions,bot,slots}=setup();slots[9]=Object.assign(makeItem('spruce_log',2),{nbt:{custom:true}});
  bot.craft=()=>assert.fail('special material must not be consumed');
  const ref=actions.observations.recipes.lookup('spruce_planks')[0]!.recipeRef;
  const result=await actions.execute({type:'craft',item:'spruce_planks',repetitions:1,recipeRef:ref});
  assert.equal(result.status,'failed');assert.equal(result.error?.code,'SPECIAL_MATERIAL_SELECTION_REQUIRED');actions.dispose();
});
test('container inspection saves history, persistence is scoped, and history is not craftable stock', async () => {
  const {bot,actions,window} = setup();
  bot.blockAt = (p:Vec3)=>({position:p,name:'chest',stateId:1,getProperties:()=>({type:'single',facing:'north'})});
  bot.openContainer = async()=>{const w=window('minecraft:generic_9x3',27);w.slots[0]=makeItem('spruce_log',6,0);return w;};
  assert.equal((await actions.execute({type:'container_inspect',position:{x:1,y:0,z:0}})).status,'succeeded');
  assert.equal(bot.currentWindow,null);
  const saved = JSON.parse(JSON.stringify(actions.observations.containers.snapshot()));
  const restored = new ContainerMemory(bot,'local'); restored.restore(saved);
  assert.equal(restored.query(['spruce_log']).containers[0]!.slots[0]!.count,6);
  assert.equal(restored.query().containers[0]!.requiresInspection,true);
  const other = new ContainerMemory(bot,'another-world'); other.restore(saved); assert.equal(other.query().total,0);
  const result:any = actions.query({type:'crafting_options',goals:[{item:'spruce_planks',count:4}]});
  assert.equal(result.data.materialsReady,false); assert.equal(result.data.containerHints.total,1);
  const before = bot.blockAt(new Vec3(1,0,0));
  bot.emit('blockUpdate',before,{...before,name:'air'});
  assert.equal(actions.observations.containers.query().containers[0]!.status,'invalidated');
  bot.game.dimension='the_nether'; assert.equal(restored.query().total,0); actions.dispose();
});
test('double chest halves share one inventory and ambiguous pair observations are not double-counted', () => {
  const {bot,actions} = setup();
  bot.blockAt = (p:Vec3)=>({position:p,name:'chest',getProperties:()=>({type:p.x===0?'left':'right',facing:'north'})});
  const w = {inventoryStart:54,slots:[makeItem('spruce_log',5,0)]};
  const memory = actions.observations.containers;
  memory.capture({x:0,y:0,z:0},w,itemDetails); memory.capture({x:1,y:0,z:0},w,itemDetails);
  assert.equal(memory.query().total,1); assert.equal(memory.query().containers[0]!.positions.length,2);
  assert.equal(memory.query().containers[0]!.slots[0]!.count,5); actions.dispose();
});
test('cancelled late container inspection neither captures inventory nor releases the native lease early',async()=>{
  const {bot,actions,window} = setup(); let open!:(w:any)=>void;
  bot.openContainer=()=>new Promise(resolve=>{open=resolve;});
  const work=actions.execute({type:'container_inspect',position:{x:1,y:0,z:0}}); await tick(); actions.stop();
  assert.equal((await work).status,'cancelled'); assert.equal(actions.busy,true);
  open(window('minecraft:generic_9x3',27)); await tick();
  assert.equal(actions.busy,false); assert.equal(actions.observations.containers.query().total,0);actions.dispose();
});
