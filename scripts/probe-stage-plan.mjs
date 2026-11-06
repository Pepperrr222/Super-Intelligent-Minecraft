// Bounded real-model probe, synthetic world only. Never connects to Minecraft or reads player logs.
import {mkdirSync,writeFileSync} from 'node:fs';
import {loadLlmFromSecrets} from '../dist/src/llm.js';
import {AgentBrain} from '../dist/src/agent-brain.js';
import {loadPromptApproval} from '../dist/src/prompt-approval.js';
import {QUERY_CONTRACTS} from '../dist/src/tool-contracts.js';
import {operationSchemas} from '../dist/src/basic-operations.js';
import {runStage} from '../dist/src/stage-plan.js';
import {randomUUID} from 'node:crypto';

const loaded=loadLlmFromSecrets('LLM_PLANNER_MODEL');
if(!loaded) {console.log('MODEL_NOT_CONFIGURED');process.exit(2);}
const brain=new AgentBrain({model:loaded.client,requirePromptApproval:true,approvedPromptHash:loadPromptApproval()});
brain.assertReady('decision');
const report=[];
for(const scenario of ['mine_and_craft','container_transfer']) {
  const table=randomUUID(),source=randomUUID(),destination=randomUUID();
  const stones=Array.from({length:10},()=>({ref:randomUUID(),name:'stone',kind:'block'}));
  const removed=new Set();let stock={cobblestone:0,stick:2,stone_pickaxe:0,oak_log:0},stored=0,sourceStock=6;
  const calls=[];
  const query=q=>{
    if(q.type==='operation_schema')return {status:'succeeded',data:{schemas:operationSchemas(q.types)}};
    if(q.type==='observe_targets')return {status:'succeeded',data:{targets:[...(q.names??[]),...(q.blockNames??[])].includes('crafting_table')?[{ref:table,name:'crafting_table'}]:stones.filter(s=>!removed.has(s.ref)).slice(0,q.limit??16)}};
    if(q.type==='snapshot')return {status:'succeeded',data:{version:'1.21.1',inventory:Object.entries(stock).map(([name,count])=>({name,count})),heldItem:{name:'wooden_pickaxe'},health:20,position:{x:0,y:64,z:0}}};
    if(q.type==='observe_inventory')return {status:'succeeded',data:{items:Object.entries(stock).filter(([,count])=>count>0).map(([name,count])=>({name,count,itemRef:randomUUID()})),emptySlots:[],nextOffset:null}};
    if(q.type==='verify')return {status:'succeeded',data:{value:q.condition.kind==='inventory_at_least'?(stock[q.condition.item]??0)>=q.condition.count:q.condition.kind==='health_at_least'?20>=q.condition.health:false}};
    return {status:'failed',error:'此合成场景已提供所需事实，仅支持本测试声明的查询'};
  };
  const objective=scenario==='mine_and_craft'?'采集提供范围内10个石头得到10圆石，再制作1把石镐。材料可用于制作，最终保留7圆石即可。':'从指定来源箱取3原木并存入指定目的箱。';
  const payload={trigger:'goal_step',queryContracts:QUERY_CONTRACTS,
    goal:{objective,originalRequest:objective+' 仅操作给定对象，不扩大范围。使用阶段方案连续执行。',
      criteria:[{id:'result',text:'阶段结束后的实际库存变化满足目标'}],status:'active'},
    facts:{synthetic:true,instantDropPickup:true,version:'1.21.1',inventory:stock,heldItem:'wooden_pickaxe',stones,tableRef:table,
      recipe:{item:'stone_pickaxe',recipeRef:'a'.repeat(64),materials:{cobblestone:3,stick:2}},
      sourceRef:source,destinationRef:destination,sourceStock},
    schemas:operationSchemas(['dig','craft','container_transfer','container_inspect','wait_until','navigate','equip']),results:[]};
  let decision;const started=Date.now();
  try {
    for(let attempt=0;attempt<3;attempt++) {
      const response=await brain.infer('decision',payload,new AbortController().signal);
      calls.push(response.raw);
      if(!response.result.ok){payload.results.push({correction:response.result.correction});continue;}
      decision=response.result.value;if(decision.kind==='plan')break;
      if(decision.kind==='query') {payload.lastTool={query:decision.query,result:query(decision.query)};payload.results.push(payload.lastTool);}
      else payload.results.push({correction:'本测试要求返回 plan；所需世界事实与动作 Schema 已提供'});
    }
    if(decision?.kind!=='plan')throw new Error('MODEL_DID_NOT_PRODUCE_PLAN');
    const stage={id:randomUUID(),revision:1,plan:decision.plan,cursor:decision.plan.entry,status:'running',deadline:Date.now()+decision.plan.maxDurationMs,transitions:0,operations:0,outputs:{},counts:{},frames:{}};
    await runStage(stage,{check(){},save(){},query,async act(op){
      if(op.type==='dig'){
        if(!stones.some(s=>s.ref===op.targetRef)||removed.has(op.targetRef))return {status:'failed',error:'INVALID_OR_ALREADY_MINED_TARGET'};
        removed.add(op.targetRef);stock.cobblestone++;return {status:'succeeded',data:{gained:1}};
      }
      if(op.type==='craft'){
        if(op.item!=='stone_pickaxe'||op.tableRef!==table||op.recipeRef!=='a'.repeat(64)||(op.count??op.repetitions)!==1||stock.cobblestone<3||stock.stick<2)return {status:'failed',error:'INVALID_CRAFT'};
        stock.cobblestone-=3;stock.stick-=2;stock.stone_pickaxe++;return {status:'succeeded',data:{gained:1}};
      }
      if(op.type==='container_transfer'){
        if(op.item!=='oak_log')return {status:'failed',error:'WRONG_ITEM'};
        if(op.direction==='withdraw'&&op.targetRef===source&&sourceStock>=op.count){stock.oak_log+=op.count;sourceStock-=op.count;}
        else if(op.direction==='deposit'&&op.targetRef===destination&&stock.oak_log>=op.count){stock.oak_log-=op.count;stored+=op.count;}
        else return {status:'failed',error:'INVALID_TRANSFER'};
        return {status:'succeeded',data:{count:op.count}};
      }
      if(op.type==='navigate'||op.type==='equip')return {status:'succeeded'};
      if(op.type==='container_inspect')return {status:'succeeded',data:{items:[{slot:0,item:{name:'oak_log',count:op.targetRef===source?sourceStock:stored}}]}};
      if(op.type==='wait_until')return {status:query({type:'verify',condition:op.condition}).data?.value?'succeeded':'failed'};
      return {status:'failed',error:'UNSUPPORTED_PROBE_OPERATION'};
    }});
    const passed=stage.status==='stage_complete'&&(scenario==='mine_and_craft'?removed.size===10&&stock.cobblestone===7&&stock.stone_pickaxe===1:stored===3&&stock.oak_log===0&&sourceStock===3);
    report.push({scenario,passed,modelCalls:calls.length,elapsedMs:Date.now()-started,operations:stage.operations,status:stage.status,stock,stored,calls});
  } catch(error){report.push({scenario,passed:false,modelCalls:calls.length,error:error.message,calls});}
  console.log(JSON.stringify({...report.at(-1),calls:undefined}));
}
mkdirSync('logs',{recursive:true});writeFileSync('logs/stage-plan-probe.json',JSON.stringify({at:new Date().toISOString(),provider:loaded.provider,model:loaded.model,syntheticWorld:true,report},null,2));
process.exitCode=report.every(r=>r.passed)?0:1;
