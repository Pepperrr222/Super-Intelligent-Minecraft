import test from 'node:test';
import assert from 'node:assert/strict';
import {packAgentContext} from '../src/agent-context.js';
const size=(p:unknown)=>Buffer.byteLength(JSON.stringify(p));
test('large duplicated batch mirrors are compacted without discarding real effects or changing durable input',()=>{
  const effect={status:'failed',data:{message:'中文观测'.repeat(500)},error:{code:'PARTIAL'}};
  const task={id:'batch',state:'failed',lastResult:effect,stepResults:[{stepId:'one',status:'partial',data:effect.data,partialEffects:[effect]}]};
  const p={goal:{originalRequest:'不要消耗我的附魔工具',criteria:[{text:'20圆石'}]},evidence:[{id:'batch-e',kind:'batch',data:task}]};
  const before=JSON.stringify(p), result=packAgentContext(p,12000);
  assert.equal(JSON.stringify(p),before);assert.ok(size(result)<size(p));
  assert.equal(result.evidence[0].data.stepResults[0].partialEffects[0].error.code,'PARTIAL');
  assert.deepEqual(result.goal,p.goal);
});
test('context packing uses UTF-8 budget, preserves current state and constraints, exposes omissions with retrievable ids',()=>{
  const text='中文历史材料'.repeat(1000);
  const p={goal:{originalRequest:'先捡木头再制作',criteria:[{text:'不能砍树'}]},direction:{constraints:['不能砍树']},
    lastEvents:[{text}],recent:[{text}],evidenceIndex:[{text}],craftingKnowledge:[{text},{text}],
    evidence:[{id:'old',kind:'query',data:{text}},{id:'new',kind:'observation',data:{status:'succeeded',data:{inventory:[{name:'wooden_pickaxe',count:1}],entities:Array(300).fill({name:'实体',text}),position:{x:1}}}}]};
  const result=packAgentContext(p,3000);
  assert.ok(size(result)<=3000);assert.deepEqual(result.goal,p.goal);assert.deepEqual(result.direction,p.direction);
  assert.equal(result.evidence[0].id,'old');assert.equal(result.evidence[0].data.omitted,true);
  assert.equal(result.evidence[1].data.data.inventory[0].name,'wooden_pickaxe');assert.equal(result.evidence[1].data.data.entitiesOmitted,300);
  assert.equal(p.evidence[1]!.data!.data!.entities!.length,300);
});
test('core player requirements are never silently truncated to fit',()=>{
  assert.throws(()=>packAgentContext({goal:{originalRequest:'约束'.repeat(1000)}},500),/CORE_CONTEXT_LIMIT/);
});
