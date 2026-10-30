import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor, ActionError } from '../src/executor.js';
const tick = () => new Promise<void>(r => setImmediate(r));
test('invalid requests never run', async () => {
  let runs=0; const e=new ActionExecutor(async()=>{runs++;});
  for (const input of [{type:'unknown'},{type:'move',controls:['forward'],durationMs:-1},{type:'look',yaw:NaN,pitch:0},{type:'select_slot',slot:9}])
    assert.equal((await e.execute(input)).status,'invalid');
  assert.equal(runs,0);
});
test('reject not-ready and already-aborted calls',async()=>{
  const e=new ActionExecutor(async()=>assert.fail('must not run'),()=>false);
  assert.equal((await e.execute({type:'wait',durationMs:1})).status,'not_ready');
  assert.equal((await e.execute({type:'wait',durationMs:1},{signal:AbortSignal.abort()})).status,'cancelled');
});
test('stop releases timed controls and allows next action',async()=>{
  let pressed=false;
  const e=new ActionExecutor(async(a,c)=>{pressed=true;c.cleanup(()=>{pressed=false;});await c.sleep(1000);});
  const first=e.execute({type:'wait',durationMs:1000}); await tick();
  assert.equal(pressed,true);
  assert.equal((await e.execute({type:'wait',durationMs:1})).status,'busy');
  e.stop(); assert.equal((await first).status,'cancelled'); await tick();
  assert.equal(pressed,false); assert.equal(e.busy,false);
});
test('uncancellable native operation keeps lease until settled',async()=>{
  let resolve!:()=>void;
  const e=new ActionExecutor(async()=>new Promise<void>(r=>{resolve=r;}));
  const pending=e.execute({type:'consume'}); await tick(); e.stop();
  assert.equal((await pending).status,'cancelled');
  assert.equal(e.busy,true);
  assert.equal((await e.execute({type:'consume'})).status,'busy');
  resolve();await tick();assert.equal(e.busy,false);
});
test('timeout cleans up; late native rejection is handled',async()=>{
  let reject!:(e:Error)=>void, cleaned=false;
  const e=new ActionExecutor(async(a,c)=>{c.cleanup(()=>{cleaned=true;});await new Promise<void>((_,r)=>{reject=r;});});
  const r=await e.execute({type:'consume'},{timeoutMs:10});
  assert.equal(r.status,'timed_out');assert.equal(cleaned,true);assert.equal(e.busy,true);
  reject(new Error('late failure'));await tick();assert.equal(e.busy,false);
});
test('external abort prevents next stage after await',async()=>{
  let release!:()=>void, secondStage=false;
  const e=new ActionExecutor(async(a,c)=>{await new Promise<void>(r=>{release=r;});c.check();secondStage=true;});
  const abort=new AbortController(), p=e.execute({type:'consume'},{signal:abort.signal});
  await tick();abort.abort();await p;release();await tick();assert.equal(secondStage,false);
});
test('success and failure both release the lease and preserve evidence',async()=>{
  let fail=false;const e=new ActionExecutor(async()=>{if(fail)throw new ActionError('MISSING_ITEM','missing');return {gained:4};});
  assert.deepEqual((await e.execute({type:'consume'})).data,{gained:4});assert.equal(e.busy,false);
  fail=true;assert.equal((await e.execute({type:'consume'})).error?.code,'MISSING_ITEM');assert.equal(e.busy,false);
});
