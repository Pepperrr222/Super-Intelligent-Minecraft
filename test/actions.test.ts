import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { MinecraftActions } from '../src/actions.js';
const require=createRequire(import.meta.url);
const fromMineflayer=createRequire(require.resolve('mineflayer'));
const registry=fromMineflayer('prismarine-registry')('1.21.4');
const tick=()=>new Promise<void>(r=>setImmediate(r));
function fixture() {
  const bot=Object.assign(new EventEmitter(), {
    registry,health:20,food:20,entity:{id:0,position:new Vec3(0,0,0),height:1.62},entities:{} as Record<number,unknown>,
    inventory:{items:()=>[],slots:[]},game:{dimension:'overworld'},currentWindow:null,
    pathfinder:{setMovements:()=>{},setGoal:()=>{},goto:async()=>{}},
    clearControlStates:()=>{},setControlState:()=>{},lookAt:async()=>{},blockAt:(_p:Vec3):any=>null,
    canDigBlock:()=>true,stopDigging:()=>{},dig:async()=>{},attack:()=>{},openContainer:async(_block:unknown):Promise<any>=>null
  });
  const actions=new MinecraftActions(bot as unknown as Bot);
  return {bot,actions};
}
test('move clears input on completion and death interrupts it',async()=>{
  const {bot,actions}=fixture();let cleared=0;bot.clearControlStates=()=>{cleared++;};
  assert.equal((await actions.execute({type:'move',controls:['forward'],durationMs:1})).status,'succeeded');
  const pending=actions.execute({type:'move',controls:['forward'],durationMs:1000});await tick();bot.emit('death');
  assert.equal((await pending).status,'cancelled');assert.equal(cleared,2);
  assert.equal((await actions.execute({type:'wait',durationMs:1})).status,'not_ready');actions.dispose();
});
test('cancel during turn never starts digging afterwards',async()=>{
  const {bot,actions}=fixture();let release!:()=>void,dug=false;
  bot.blockAt=()=>({position:new Vec3(0,0,1),stateId:1,diggable:true});
  bot.lookAt=()=>new Promise<void>(r=>{release=r;});bot.dig=async()=>{dug=true;};
  const pending=actions.execute({type:'dig',position:{x:0,y:0,z:1}});await tick();actions.stop();
  assert.equal((await pending).status,'cancelled');release();await tick();assert.equal(dug,false);actions.dispose();
});
test('unloaded blocks fail without digging',async()=>{
  const {bot,actions}=fixture();bot.dig=async()=>assert.fail('must not dig');
  assert.equal((await actions.execute({type:'dig',position:{x:0,y:0,z:1}})).error?.code,'UNLOADED_BLOCK');actions.dispose();
});
test('late container open is closed after cancellation without transferring',async()=>{
  const {bot,actions}=fixture();let release!:(window:unknown)=>void,closed=0;
  bot.blockAt=()=>({position:new Vec3(0,0,1)});
  bot.openContainer=()=>new Promise(r=>{release=r;});
  const pending=actions.execute({type:'container_transfer',position:{x:0,y:0,z:1},direction:'withdraw',item:'dirt',count:1});
  await tick();actions.stop();assert.equal((await pending).status,'cancelled');
  const window={close:()=>{closed++;},withdraw:async()=>assert.fail('must not transfer')};
  Object.assign(bot,{currentWindow:window});release(window);await tick();assert.equal(closed,1);actions.dispose();
});
test('attack result reports sent, never claims damage or kill',async()=>{
  const {bot,actions}=fixture();let hits=0;bot.attack=()=>{hits++;};
  bot.entities[5]={id:5,isValid:true,position:new Vec3(1,0,0)};
  const r=await actions.execute({type:'attack_once',entityId:5});
  assert.deepEqual(r.data,{evidence:'attack_sent',damageConfirmed:false});assert.equal(hits,1);actions.dispose();
});
test('follow stops when target disappears',async()=>{
  const {bot,actions}=fixture();let stopped=false;
  bot.entities[5]={id:5,isValid:true,position:new Vec3(1,0,0)};
  bot.pathfinder.setGoal=(goal?:unknown)=>{if(goal===null)stopped=true;};
  const p=actions.execute({type:'follow',entityId:5,durationMs:1000});await tick();delete bot.entities[5];
  assert.equal((await p).error?.code,'ENTITY_NOT_FOUND');assert.equal(stopped,true);actions.dispose();
});
