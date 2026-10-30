import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { fixture, tick } from './fixtures.js';

function setup() {
  const f=fixture('1.21.1'), points:Vec3[]=[];
  const entity={id:42,name:'player',type:'player',username:'Tester',height:1.8,eyeHeight:1.62,
    position:new Vec3(3,0,4),metadata:[] as unknown[],isValid:true};
  f.bot.entities[42]=entity;
  f.bot.lookAt=async(p:Vec3,force:boolean)=>{assert.equal(force,true);points.push(p);};
  f.bot.setControlState=()=>assert.fail('looking must not move');
  f.bot.pathfinder.setGoal=()=>assert.fail('looking must not navigate');
  return {...f,entity,points,poseIndex:f.bot.registry.entitiesByName.player.metadataKeys.indexOf('pose')};
}
test('look_at_entity defaults to head and never moves or tracks',async()=>{
  const {actions,entity,points}=setup();
  const r=await actions.execute({type:'look_at_entity',entityId:42});
  assert.equal(r.status,'succeeded');assert.deepEqual(points,[new Vec3(3,1.62,4)]);
  assert.equal((r.data as any).part,'head');assert.equal((r.data as any).tracking,false);
  entity.position.x=8;await tick();assert.equal(points.length,1);actions.dispose();
});
test('head/body/legs/feet have ordered heights and feet have zero offset',async()=>{
  const {bot,actions,entity,points}=setup();entity.position.y=64;bot.entity.position.y=64;
  for (const part of ['head','body','legs','feet']) assert.equal((await actions.execute({type:'look_at_entity',entityId:42,part})).status,'succeeded');
  assert.ok(points[0].y>points[1].y && points[1].y>points[2].y && points[2].y>points[3].y);
  assert.equal(points[3].y,64);assert.deepEqual(entity.position,new Vec3(3,64,4));actions.dispose();
});
test('1.21.1 pose metadata overrides stale standing height for crouch/swim/crawl/glide',async()=>{
  const {actions,entity,points,poseIndex}=setup();assert.ok(poseIndex>=0);
  for (const [pose,head] of [[5,1.27],[3,0.4],[1,0.4],[4,0.4],[0,1.62]]) {
    entity.metadata[poseIndex]=pose;
    const r=await actions.execute({type:'look_at_entity',entityId:42});assert.equal(r.status,'succeeded');assert.equal(points.at(-1)!.y,head);
  }
  actions.dispose();
});
test('crouching flag works when pose metadata has not arrived',async()=>{
  const {bot,actions,points}=setup();bot.entities[42].crouching=true;
  assert.equal((await actions.execute({type:'look_at_entity',entityId:42})).status,'succeeded');assert.equal(points[0].y,1.27);actions.dispose();
});
test('non-player dimensions are used instead of fixed player height',async()=>{
  const {bot,actions,points}=setup();bot.entities[7]={id:7,name:'cow',height:0.7,position:new Vec3(1,0,0)};
  const r=await actions.execute({type:'look_at_entity',entityId:7,part:'head'});assert.equal(r.status,'succeeded');assert.equal(points[0].y,0.63);actions.dispose();
});
test('unknown poses are explicit and feet still require no height estimate',async()=>{
  const {actions,entity,points,poseIndex}=setup();entity.metadata[poseIndex]=2;
  assert.equal((await actions.execute({type:'look_at_entity',entityId:42})).error?.code,'UNSUPPORTED_POSE');assert.equal(points.length,0);
  assert.equal((await actions.execute({type:'look_at_entity',entityId:42,part:'feet'})).status,'succeeded');actions.dispose();
});
test('invalid parts, missing and out-of-range entities do not turn',async()=>{
  const {actions,entity,points}=setup();
  assert.equal((await actions.execute({type:'look_at_entity',entityId:42,part:'hat'})).status,'invalid');
  assert.equal((await actions.execute({type:'look_at_entity',entityId:999})).error?.code,'ENTITY_NOT_FOUND');
  entity.position.x=100;
  assert.equal((await actions.execute({type:'look_at_entity',entityId:42})).error?.code,'ENTITY_NOT_FOUND');assert.equal(points.length,0);actions.dispose();
});
test('cancel while turning keeps lease until native look resolves',async()=>{
  const {bot,actions}=setup();let release!:()=>void;bot.lookAt=()=>new Promise<void>(r=>release=r);
  const p=actions.execute({type:'look_at_entity',entityId:42});await tick();actions.stop();
  assert.equal((await p).status,'cancelled');assert.equal(actions.busy,true);release();await tick();assert.equal(actions.busy,false);actions.dispose();
});
