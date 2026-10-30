const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const source = path.join(root,'.reference/CoCraftBench');
const read = file => JSON.parse(fs.readFileSync(path.join(source,file),'utf8'));
const catalog = read('benchmark-design/v0.3/action-catalog.json');
const mapping = read('benchmark-design/v0.3/task-interface-map.json');
// These are semantic mappings to SIM primitives, never aliases claiming contract compatibility.
const rows = {
  'observe.snapshot':['primitive',[],['snapshot','inspect_block','find_blocks'],'已加载半径观测；原始组件可读，不含所有1.21.6语义解码和规范slotRef生命周期'],
  'navigation.goto':['primitive',['navigate'],[],'禁止路径挖掘和搭方块；仍需任务许可区域与保护区域策略'],
  'navigation.control':['primitive',['move','look','look_at','look_at_entity','move_ticks','wait_ticks'],[],'本地physicsTick控制；看向实体按部位计算高度；水下/坠落策略由控制器负责'],
  'gather.collect':['controller_needed',['navigate','dig'],['find_blocks','verify'],'缺目标挑选、拾取实体跟踪、背包满恢复和来源验证'],
  'block.break':['primitive',['dig','equip'],['inspect_block','verify'],'有方块变化核验；许可区域与掉落来源尚未实现'],
  'block.place':['controller_needed',['place','place_entity','look','look_at'],['inspect_block','verify'],'有support+face；缺朝向/含水/双格方块放置策略'],
  'inventory.equip':['primitive',['equip','unequip','select_slot'],['snapshot'],'按名称装备接口不等同于规范的带revision精确slotRef'],
  'inventory.transfer':['primitive',['container_transfer','container_inspect','inventory_move','toss'],['snapshot'],'容器与空槽整理可用；丢弃许可区和完整cursor恢复待实现'],
  'inventory.bundle':['experimental_gap',[],['snapshot'],'缺1.21.6收纳袋GUI适配与容量规则'],
  'item.use':['primitive',['use_item','use_item_ticks','consume','activate_block','activate_entity','activate_entity_at'],['snapshot','verify'],'定点交互仅主手；持用不证明命中或效果'],
  'craft.make':['primitive',['craft','craft_output'],['recipes'],'支持配方次数和目标产量换算；缺材料由上层补齐'],
  'furnace.smelt':['controller_needed',['furnace_inspect','furnace_put','furnace_take'],[],'提供装料/燃料/事件等待取出；例子演示组合，持久恢复与燃料规划待补'],
  'brewing.brew':['controller_needed',['brewing_inspect','brewing_put','brewing_take'],[],'已有1.21.6限定槽位读写；缺药水组件解码、配方状态机、燃料/进度协议和实测'],
  'workstation.process':['experimental_gap',[],[],'缺砂轮/制图/切石/锻造/合成器专用适配，未暴露任意clickWindow或数据包'],
  'villager.trade':['primitive',['trade_inspect','trade'],['snapshot'],'实时报价指纹匹配与第二输入检查；未实现基准entityRef会话身份契约'],
  'villager.manage_job':['controller_needed',['place','dig','trade_inspect','wait_until'],['snapshot'],'放置工作站不证明职业归属；缺职业元数据解码与时段控制'],
  'enchanting.enchant':['primitive',['enchant'],['snapshot'],'窗口槽位转换、显示等级/消耗区分、实际附魔检查；指定稀有附魔不是保证'],
  'anvil.process':['primitive',['anvil'],['snapshot'],'等级预算与耐久/附魔检查；原生选择有歧义时拒绝；完整现代组件保真仍待实测'],
  'combat.melee':['controller_needed',['attack_once','look_at','move_ticks','wait_ticks'],['snapshot'],'禁止直接攻击玩家及附近挥砍风险；缺冷却、跳劈/重锤状态机和伤害归因'],
  'combat.shoot':['controller_needed',['look','look_at','use_item_ticks','select_slot'],['snapshot'],'缺弹道、目标提前量、弩装填解码和玩家射线检查'],
  'combat.shield':['controller_needed',['equip','look_at','use_item_ticks'],['snapshot'],'可副手持用；缺威胁转向、禁用/起盾状态检测与格挡证据'],
  'combat.parry':['experimental_gap',[],['snapshot'],'缺可反射弹射物白名单、轨迹预测和来源链判定'],
  'movement.clutch':['experimental_gap',['move_ticks','look_at','activate_block','use_item_ticks'],['snapshot'],'有输入积木，不具备落点预测、水桶/风弹救援时序'],
  'vehicle.mount':['controller_needed',['mount','place_entity'],['snapshot'],'仅普通船/竹筏；乘坐关系不代表驾驶席'],
  'vehicle.drive':['experimental_gap',['vehicle_control'],['snapshot'],'仅普通船/竹筏水平输入，未实现快乐恶魂三维驾驶或路线控制'],
  'vehicle.dismount':['experimental_gap',['dismount'],['snapshot'],'新player_input分支明确UNSUPPORTED；其他版本仅关系核验，不证明安全落脚'],
  'animal.interact':['controller_needed',['equip','activate_entity','activate_entity_at','use_item_ticks'],['snapshot'],'缺年龄/主人/装备元数据语义与喂食、剪取后置条件'],
  'animal.leash':['experimental_gap',['activate_entity','activate_entity_at'],['snapshot'],'没有可靠拴绳关系图、动物互拴和货物吊运验证'],
  'world.portal':['controller_needed',['activate_block','navigate','wait_until'],['verify','snapshot'],'可以等待维度变化；缺点燃、双向地标和跨维度路径技能'],
  'world.redstone':['controller_needed',['activate_block','place','wait_until'],['inspect_block','verify'],'有状态读回；缺电路因果与红石建造/朝向控制器'],
  'world.archaeology':['experimental_gap',['look_at','activate_block','use_item_ticks'],['inspect_block'],'未验证刷扫持续包与dusted进度，禁止用dig代替'],
  'trial.interact':['controller_needed',['activate_block','consume','attack_once'],['inspect_block','snapshot'],'仅交互积木；试炼完成/奖励归属与宝库资格需grader'],
  'world.wait_until':['primitive',['wait_until','wait','wait_ticks'],['verify'],'只支持显式白名单条件；未知返回unknown，墙钟超时终止'],
  'world.fish':['primitive',['fish_once','look_at'],['snapshot','verify'],'原生咬钩/收竿；渔获拾取需独立核验，取消可能保留原生租约'],
  'build.blueprint':['controller_needed',['navigate','place','dig'],['inspect_block','verify'],'缺蓝图解析、放置次序、差异修复与revision停止'],
  'plan.checkpoint':['planner_needed',[],[],'计划账本持久化不属于Mineflayer底层，本次未实现'],
  'plan.resume':['planner_needed',[],['snapshot','verify'],'缺持久计划与当前世界对账，不能盲重放消耗操作'],
  'plan.revise':['planner_needed',[],['snapshot','verify'],'缺计划revision与旧动作对账；底层已有stop'],
  'verify.local':['primitive',[],['verify'],'5类条件true/false/unknown；不是230条benchmark谓词实现'],
  'npc.say':['primitive',['say'],[],'基础命令/JSON/调用过滤；全系统聊天出口和提示词注入防护未接入'],
  'action.status':['service_partial',[],[],'已有busy和execute结果；缺action_id索引账本、幂等重放和progress协议'],
  'action.cancel':['service_partial',[],[],'已有stop/AbortSignal与租约清理；缺规范cleanup/partial_effects外壳']
};
async function main() {
  const {actionSchema,querySchema} = await import('../dist/src/schema.js');
  const actions = new Set(actionSchema.options.map(o=>o.shape.type.value));
  const queries = new Set(querySchema.options.map(o=>o.shape.type.value));
  const names = catalog.actions.map(a=>a.name);
  if (names.length!==42 || Object.keys(rows).length!==42 || mapping.tasks.length!==100) throw Error('Source shape changed; review mapping');
  for (const name of names) {
    if (!rows[name]) throw Error(`Unmapped: ${name}`);
    for (const a of rows[name][1]) if(!actions.has(a))throw Error(`Unknown SIM action ${a}`);
    for (const q of rows[name][2]) if(!queries.has(q))throw Error(`Unknown SIM query ${q}`);
  }
  const commit = execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
  if (commit!=='be208787b6d1831c8897e42a505319c04db5923b') throw Error('Source commit changed; review contracts before regenerating');
  const operations = names.map(name=>({name,classification:rows[name][0],simActions:rows[name][1],simQueries:rows[name][2],remainingWork:rows[name][3],liveValidation:'not_run',contractCompatible:false}));
  const tasks = mapping.tasks.map(task=>({taskId:task.task_id,title:task.title,sourceActions:task.action_ids,
    simActions:[...new Set(task.action_ids.flatMap(name=>rows[name][1]))].sort(),
    simQueries:[...new Set(task.action_ids.flatMap(name=>rows[name][2]))].sort(),
    missingControllers:task.action_ids.filter(name=>!['primitive','service_partial'].includes(rows[name][0])),
    liveValidation:'not_run', taskPassed:null}));
  const output = { source:'https://github.com/Serein55/CoCraftBench',commit,targetMinecraft:'1.21.6',
    sourceMineflayer:'4.33.0 (source-audit mentions local patches)',simMineflayer:'4.39.0',
    note:'primitive means SIM has underlying operations, not full benchmark contract coverage or proven task success.',
    simActionCount:actions.size,queryCount:queries.size,operations,tasks };
  fs.writeFileSync(path.join(root,'docs/cocraftbench-coverage.json'),JSON.stringify(output,null,2)+'\n');
  const lines = ['# CoCraftBench 100题与SIM底层能力对照','',`来源提交：\`${commit}\`。由 scripts/analyze-cocraftbench.cjs 生成。`,'',
    '全部任务均未实机执行。表中列出可组合的SIM动作与主要上层缺口，不能据此认定任务已通过。action.status/cancel、身份、许可区域等跨任务协议缺口见详细分析。','',
    '|任务|题目|可用SIM动作|待补控制器/规划|','|---|---|---|---|',
    ...tasks.map(t=>`|${t.taskId}|${t.title}|${t.simActions.join(', ')}|${t.missingControllers.join(', ') || '仍需任务编排、基准协议与实测'}|`)];
  fs.writeFileSync(path.join(root,'docs/cocraftbench-tasks.md'),lines.join('\n')+'\n');
  console.log(JSON.stringify({sourceCommit:commit,operations:operations.length,tasks:tasks.length,simActions:actions.size,queries:queries.size,liveValidation:'not_run'}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
