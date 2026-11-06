const bytes = (value:unknown) => Buffer.byteLength(JSON.stringify(value),'utf8');
/** Remove redundant scheduler mirrors; retain actual per-action effects and error evidence. */
function compact(value:any):any {
  if(Array.isArray(value)) return value.map(compact);
  if(!value || typeof value!=='object') return value;
  if(Array.isArray(value.stepResults)) {
    return {id:value.id,state:value.state,currentStep:value.currentStep,totalSteps:value.totalSteps,
      stepResults:value.stepResults.map((s:any)=>({stepId:s.stepId,status:s.status,error:compact(s.error),
        partialEffects:compact(s.partialEffects),...(!s.partialEffects?.length?{data:compact(s.data)}:{})}))};
  }
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,compact(v)]));
}

/** Byte-bounded working context. Full events remain in the durable store for read_evidence. */
export function packAgentContext(payload:unknown, maxBytes:number):any {
  const p:any=compact(payload);
  if(bytes(p)<=maxBytes) return p;
  p.contextCompaction={omitted:true,instruction:'历史内容省略不等于不存在或失败；需要具体事实时 read_evidence(id)。当前玩家要求不得更改。'};
  // Goal, latest message, direction, proposal and natural-language acceptance criteria stay intact.
  for(const key of ['lastEvents','recent','evidenceIndex','containerMemory']) {
    if(bytes(p)<=maxBytes) return p;
    if(p[key]!==undefined) {delete p[key];p.contextCompaction[key]='omitted';}
  }
  // Preserve the newest successful observation and the newest batch; shrink older evidence first.
  const evidence:any[]=p.evidence ?? [];
  const fresh=evidence.filter(e=>e.kind==='observation').at(-1);
  const batch=evidence.filter(e=>e.kind==='batch').at(-1);
  const order=[...evidence.filter(e=>e!==fresh && e!==batch),...evidence.filter(e=>e===batch),...evidence.filter(e=>e===fresh)];
  for(const e of order) {
    if(bytes(p)<=maxBytes) return p;
    if(e===fresh) {
      const data=e.data?.data;
      if(data?.entities) {data.entitiesOmitted=data.entities.length;delete data.entities;}
      // Keep current inventory/equipment/position; never replace the only fresh observation with a success claim.
      continue;
    }
    e.data={omitted:true,instruction:'read_evidence 获取完整记录'};
  }
  for(const key of ['results','craftingKnowledge']) {
    if(bytes(p)<=maxBytes) return p;
    if(Array.isArray(p[key]) && p[key].length>1) {p[key]=p[key].slice(-1);p.contextCompaction[key]='older entries omitted';}
  }
  if(bytes(p)>maxBytes && p.craftingKnowledge) {delete p.craftingKnowledge;p.contextCompaction.craftingKnowledge='请按需查询 crafting_options，缩小 goals/includeDependencies';}
  if(bytes(p)>maxBytes && Array.isArray(p.results)) p.results=p.results.map((r:any)=>r.readEvidence
    ? {readEvidence:r.readEvidence.map((e:any)=>e?{...e,data:compact(e.data)}:e)} : r);
  if(bytes(p)>maxBytes) throw new Error('V2_CORE_CONTEXT_LIMIT: 当前要求或单份证据过大，无法在保留必要事实的前提下压缩');
  return p;
}
