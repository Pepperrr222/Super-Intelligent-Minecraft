import { z } from 'zod';
import { basicOperationSchema, querySchema,conditionSchema, type BasicOperation } from './schema.js';

const id=z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const path=z.array(z.union([z.string().regex(/^(?!__proto__$|constructor$|prototype$)[a-zA-Z_][a-zA-Z0-9_]*$/),z.number().int().min(0).max(255)])).max(12);
const source=z.object({node:id,path}).strict();
const binding=z.object({parameter:path.min(1),from:source}).strict();
const test=z.object({from:source,compare:z.enum(['eq','ne','gte','gt','lte','lt']),value:z.union([z.string(),z.number().finite(),z.boolean(),z.null()])}).strict();
const params=z.record(z.string(),z.json());
const bindings=z.array(binding).max(16);
const operationTypes=basicOperationSchema.options.map(o=>o.shape.type.value) as [BasicOperation['type'],...BasicOperation['type'][]];
const queryTypes=querySchema.options.map(o=>o.shape.type.value) as [string,...string[]];
export const stageNodeSchema=z.discriminatedUnion('kind',[
  z.object({id,kind:z.literal('value'),value:z.json(),next:id}).strict(),
  z.object({id,kind:z.literal('query'),query:z.object({type:z.enum(queryTypes),params}).strict(),bindings,next:id}).strict(),
  z.object({id,kind:z.literal('act'),operation:z.object({type:z.enum(operationTypes),params}).strict(),bindings,next:id}).strict(),
  z.object({id,kind:z.literal('branch'),test,yes:id,no:id}).strict(),
  z.object({id,kind:z.literal('repeat'),maxIterations:z.number().int().min(1).max(128),body:id,next:id}).strict(),
  z.object({id,kind:z.literal('foreach'),from:source,limit:z.number().int().min(1).max(128),body:id,next:id}).strict(),
  z.object({id,kind:z.literal('end'),outcome:z.enum(['stage_complete','needs_decision']),reason:z.string().min(1).max(1000)}).strict(),
]);
export const stagePlanSchema=z.object({purpose:z.string().min(1).max(2000),entry:id,
  guards:z.array(conditionSchema).max(8).default([]),
  maxOperations:z.number().int().min(1).max(128),maxDurationMs:z.number().int().min(100).max(300000),
  nodes:z.array(stageNodeSchema).min(1).max(48)}).strict().superRefine((plan,c)=>{
    if(Buffer.byteLength(JSON.stringify(plan))>32000)c.addIssue({code:'custom',message:'阶段方案超过32KB，请缩小阶段范围'});
    const ids=new Set(plan.nodes.map(n=>n.id));
    if(ids.size!==plan.nodes.length || !ids.has(plan.entry)) c.addIssue({code:'custom',message:'节点 id 必须唯一且 entry 必须存在'});
    for(const n of plan.nodes) {
      const links=n.kind==='end'?[]:n.kind==='branch'?[n.yes,n.no]:n.kind==='repeat'||n.kind==='foreach'?[n.body,n.next]:[n.next];
      if(links.some(l=>!ids.has(l))) c.addIssue({code:'custom',message:`${n.id}: 跳转目标不存在`});
      const sources=n.kind==='branch'?[n.test.from]:n.kind==='foreach'?[n.from]:('bindings' in n?n.bindings.map(b=>b.from):[]);
      if(sources.some(s=>!ids.has(s.node))) c.addIssue({code:'custom',message:`${n.id}: 数据来源不存在`});
      if(n.kind==='act' && n.operation.type==='say') c.addIssue({code:'custom',message:'阶段不能绕过主控回复'});
      if(n.kind==='act' && !n.bindings.length && !basicOperationSchema.safeParse({...n.operation.params,type:n.operation.type}).success)
        c.addIssue({code:'custom',message:`${n.id}: 静态动作参数无效，请查询 operation_schema`});
      if(n.kind==='query' && !n.bindings.length && !querySchema.safeParse({...n.query.params,type:n.query.type}).success)
        c.addIssue({code:'custom',message:`${n.id}: 静态查询参数无效`});
    }
    // Definite dataflow: every binding must have a successful producer on every path to its consumer.
    if(ids.size!==plan.nodes.length || !ids.has(plan.entry)) return;
    const edges=plan.nodes.flatMap(n=>(n.kind==='end'?[]:n.kind==='branch'?[n.yes,n.no]:n.kind==='repeat'||n.kind==='foreach'?[n.body,n.next]:[n.next])
      .map(to=>({from:n.id,to,produces:n.kind==='value'||n.kind==='query'||n.kind==='act'||n.kind==='foreach'&&to===n.body,
        removes:n.kind==='foreach'&&to===n.next})));
    if(edges.some(e=>!ids.has(e.to))) return;
    const reachable=new Set([plan.entry]);
    for(let i=0;i<plan.nodes.length;i++) for(const e of edges) if(reachable.has(e.from))reachable.add(e.to);
    if(reachable.size!==ids.size) c.addIssue({code:'custom',message:'存在从 entry 无法到达的节点；查询生产节点必须在使用其结果前执行'});
    const inputs=new Map([...ids].map(i=>[i,i===plan.entry?new Set<string>():new Set(ids)]));
    for(let i=0;i<plan.nodes.length*2;i++) {
      let changed=false;
      for(const n of plan.nodes) {
        if(n.id===plan.entry || !reachable.has(n.id))continue;
        const predecessors=edges.filter(e=>e.to===n.id&&reachable.has(e.from)).map(e=>{
          const s=new Set(inputs.get(e.from));if(e.produces)s.add(e.from);if(e.removes)s.delete(e.from);return s;
        });
        const next=new Set([...ids].filter(id=>predecessors.length&&predecessors.every(s=>s.has(id))));
        if([...next].sort().join()!==[...inputs.get(n.id)!].sort().join()){inputs.set(n.id,next);changed=true;}
      }
      if(!changed)break;
    }
    for(const n of plan.nodes) {
      const sources=n.kind==='branch'?[n.test.from]:n.kind==='foreach'?[n.from]:('bindings' in n?n.bindings.map(b=>b.from):[]);
      for(const s of sources) if(!inputs.get(n.id)?.has(s.node)) c.addIssue({code:'custom',message:`${n.id}: 来源 ${s.node} 尚未在所有路径执行；entry 应从查询开始，不能先遍历未知结果`});
    }
});
export type StagePlan=z.infer<typeof stagePlanSchema>;
export const stageStateSchema=z.object({id:z.string(),revision:z.number().int(),plan:stagePlanSchema,
  cursor:id,status:z.enum(['running','interrupted','stage_complete','needs_decision']),
  deadline:z.number(),transitions:z.number().int().nonnegative(),operations:z.number().int().nonnegative(),
  outputs:z.record(z.string(),z.unknown()),counts:z.record(z.string(),z.number().int().nonnegative()),
  frames:z.record(z.string(),z.object({items:z.array(z.unknown()).max(128),index:z.number().int().nonnegative()})),
  pendingNode:id.optional(),reason:z.string().optional()}).strict();
export type StageState=z.infer<typeof stageStateSchema>;
export type StagePort={check():void;save():void;query(input:unknown):{status:string;data?:unknown;error?:unknown};
  act(operation:BasicOperation,deadline:number):Promise<{status:string;data?:unknown;error?:unknown}>;
  now?:()=>number};
const forbidden=new Set(['__proto__','constructor','prototype']);
function read(root:any,keys:(string|number)[]):unknown {
  let value=root;
  for(const key of keys) {
    if(forbidden.has(String(key)) || value==null || !Object.hasOwn(value,key)) throw new Error(`STAGE_MISSING_DATA: path=${JSON.stringify(keys)} missing=${String(key)} available=${JSON.stringify(value && typeof value==='object'?Object.keys(value).slice(0,20):[])}；修正结果路径或重新查询，不要原样重放`);
    value=value[key];
  }
  if(value===undefined) throw new Error('STAGE_MISSING_DATA');
  return value;
}
function bound(template:{type:string;params:Record<string,unknown>},bindings:z.infer<typeof binding>[],state:StageState) {
  const p=structuredClone(template.params) as any;
  for(const b of bindings) {
    let dest=p;
    for(const key of b.parameter.slice(0,-1)) {
      if(!Object.hasOwn(dest,key) || dest[key]===null || typeof dest[key]!=='object') throw new Error('STAGE_INVALID_BINDING_PATH');
      dest=dest[key];
    }
    dest[b.parameter.at(-1)!]=structuredClone(read(state.outputs[b.from.node],b.from.path));
  }
  return {...p,type:template.type};
}
function condition(t:z.infer<typeof test>,state:StageState) {
  const a=read(state.outputs[t.from.node],t.from.path),b=t.value;
  if(a==='unknown' || a===undefined || typeof a==='object' && a!==null) throw new Error('STAGE_UNKNOWN_CONDITION');
  if(t.compare==='eq'||t.compare==='ne') return t.compare==='eq'?a===b:a!==b;
  if(typeof a!=='number'||typeof b!=='number') throw new Error('STAGE_CONDITION_TYPE');
  return t.compare==='gte'?a>=b:t.compare==='gt'?a>b:t.compare==='lte'?a<=b:a<b;
}
/** Runs only an approved bounded graph. No model calls, hidden retries or alternative targets. */
export async function runStage(state:StageState,port:StagePort):Promise<void> {
  const now=port.now ?? Date.now;
  try {
    if(state.status!=='running' || state.pendingNode) throw new Error('STAGE_RECOVERY_REQUIRED');
    while(state.status==='running') {
      port.check();
      // Even branch-only graphs must let stop/chat/world events enter the event loop.
      await new Promise<void>(resolve=>setImmediate(resolve));port.check();
      if(now()>=state.deadline) throw new Error('STAGE_TIME_LIMIT');
      if(state.transitions>=512) throw new Error('STAGE_TRANSITION_LIMIT');
      if(Buffer.byteLength(JSON.stringify({outputs:state.outputs,frames:state.frames}))>96000)throw new Error('STAGE_MEMORY_LIMIT');
      const node=state.plan.nodes.find(n=>n.id===state.cursor);
      if(!node) throw new Error('STAGE_UNKNOWN_NODE');
      state.transitions++;
      if(node.kind==='end') {state.status=node.outcome;state.reason=node.reason;port.save();return;}
      if(node.kind==='value') {
        if(Buffer.byteLength(JSON.stringify(node.value))>16000)throw new Error('STAGE_LITERAL_TOO_LARGE');
        state.outputs[node.id]=structuredClone(node.value);state.cursor=node.next;port.save();continue;
      }
      if(node.kind==='branch') {state.cursor=condition(node.test,state)?node.yes:node.no;port.save();continue;}
      if(node.kind==='repeat') {
        const count=state.counts[node.id] ?? 0;
        if(count>=node.maxIterations) {state.cursor=node.next;delete state.counts[node.id];}
        else {state.counts[node.id]=count+1;state.cursor=node.body;}
        port.save();continue;
      }
      if(node.kind==='foreach') {
        let frame=state.frames[node.id];
        if(!frame) {
          const items=read(state.outputs[node.from.node],node.from.path);
          if(!Array.isArray(items)) throw new Error('STAGE_EXPECTED_LIST');
          frame={items:structuredClone(items.slice(0,node.limit)),index:0};state.frames[node.id]=frame;
        }
        if(frame.index>=frame.items.length) {delete state.frames[node.id];delete state.outputs[node.id];state.cursor=node.next;}
        else {state.outputs[node.id]=frame.items[frame.index++];state.cursor=node.body;}
        port.save();continue;
      }
      port.check();
      let result:{status:string;data?:unknown;error?:unknown};
      if(node.kind==='query') result=port.query(querySchema.parse(bound(node.query,node.bindings,state)));
      else {
        if(state.operations>=state.plan.maxOperations) throw new Error('STAGE_OPERATION_LIMIT');
        for(const guard of state.plan.guards) {
          port.check();const checked=port.query({type:'verify',condition:guard});
          if(checked.status!=='succeeded' || (checked.data as any)?.value!==true) throw new Error('STAGE_GUARD_UNMET: 阶段约束不再满足或未知');
        }
        const op=basicOperationSchema.parse(bound(node.operation,node.bindings,state));
        if(op.type==='say') throw new Error('STAGE_CHAT_FORBIDDEN');
        state.pendingNode=node.id;state.operations++;port.save();port.check();
        result=await port.act(op,state.deadline);
      }
      port.check();
      if(result.status!=='succeeded') throw new Error(`STAGE_NODE_FAILED ${node.id}: ${JSON.stringify(result.error ?? result.status)}`);
      if(Buffer.byteLength(JSON.stringify(result.data ?? null))>16000) throw new Error(`STAGE_OUTPUT_TOO_LARGE ${node.id}: 缩小查询范围`);
      state.outputs[node.id]=result.data ?? null;
      if(Buffer.byteLength(JSON.stringify(state.outputs))>64000) throw new Error('STAGE_MEMORY_LIMIT');
      state.pendingNode=undefined;state.cursor=node.next;port.save();
    }
  } catch(error) {
    state.status='interrupted';state.reason=error instanceof Error?error.message:String(error);port.save();
    throw error;
  }
}
