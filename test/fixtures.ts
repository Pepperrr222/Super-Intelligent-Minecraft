import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import type { Bot } from 'mineflayer';
import { MinecraftActions } from '../src/actions.js';
import type { Item } from '../src/observation.js';
const require = createRequire(import.meta.url);
const native = createRequire(require.resolve('mineflayer'));
export const registry = native('prismarine-registry')('1.21.6');
export const ItemClass = native('prismarine-item')(registry);
export const tick = () => new Promise<void>(r=>setImmediate(r));
export function makeItem(name: string, count = 1, slot = 9): Item {
  const item = new ItemClass(registry.itemsByName[name].id,count); item.slot=slot; return item;
}
export function fixture(version = '1.21.6'): {bot:any; actions:MinecraftActions; slots:Array<Item|null>; window(type:string,start?:number):any} {
  const slots: Array<Item | null> = Array(46).fill(null);
  const bot: any = Object.assign(new EventEmitter(), {
    registry:version==='1.21.6' ? registry : native('prismarine-registry')(version),version,health:20,food:20,experience:{level:35},oxygenLevel:20,
    entity:{id:0,position:new Vec3(0,0,0),height:1.62},entities:{},currentWindow:null,
    inventory:{slots,inventoryStart:9,inventoryEnd:45,selectedItem:null,items:()=>slots.filter((i): i is Item=>!!i)},
    game:{dimension:'overworld',gameMode:'survival'},pathfinder:{setMovements:()=>{},setGoal:()=>{}},
    clearControlStates:()=>{},setControlState:()=>{},activateItem:()=>{},deactivateItem:()=>{},
    blockAt:(p:Vec3)=>({position:p,name:'furnace',stateId:1,getProperties:()=>({lit:false})}),
    findBlocks:()=>[],supportFeature:()=>true,chat:()=>{},
    closeWindow:async(w:any)=>w.close()
  });
  const actions = new MinecraftActions(bot as Bot);
  function window(type: string, start = 3) {
    const w: any = Object.assign(new EventEmitter(), {type,inventoryStart:start,inventoryEnd:start+36,
      slots:Array(start+36).fill(null),closed:0});
    for (let i=9;i<45;i++) {
      if (slots[i]) {
        w.slots[start+i-9]=Object.assign(Object.create(Object.getPrototypeOf(slots[i])),slots[i]);
        w.slots[start+i-9].slot=start+i-9;
      }
    }
    w.close=()=>{
      w.closed++;
      for (let i=9;i<45;i++) { slots[i]=w.slots[start+i-9]; if(slots[i])slots[i]!.slot=i; }
      if(bot.currentWindow===w)bot.currentWindow=null;
      w.emit('close');
    };
    bot.currentWindow=w; return w;
  }
  return {bot,actions,slots,window};
}
