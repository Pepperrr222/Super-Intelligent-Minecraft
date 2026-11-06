# 配方知识、递归需求与精确制作

2026-11-03：模型优先使用新增 crafting_options 一次查询合并配方、库存检查和材料依赖；短引用、缓存及持久容器线索见 [资源知识](resource-knowledge.md)。旧查询保留兼容。以下为首版接口记录。

后续更新：P2 已新增 observe_targets 查询与基本操作网关，最新为 244 项自动测试通过；下文 235 项及“三种查询”属于配方首轮基线。统一模型查询现在也支持短期目标观测，接口与实机探针限制见 [基本操作](basic-operations.md)。

状态：2026-11-01 首版实现，17 项新增回归通过，总计 235 项模拟测试通过；尚无本轮真实模型/服务器验收。数据源为 Mineflayer 4.39.0 所用的本地版本合成规则；JEI 桥接与百科查询未实现。

## 查询契约

查询走 `MinecraftActions.query()`，没有游戏写操作。旧 `recipes` 仍只返回当前材料与指定设施下可制作的配方。

### recipe_lookup：理论配方

```json
{"type":"recipe_lookup","item":"wooden_pickaxe","offset":0,"limit":4}
```

忽略库存与设施是否存在，返回 source/version/revision、scope=local_version_rules、serverRulesVerified=false、recipes、total、nextOffset。每个配方包含 recipeRef、result:{item,count}、正数原料列表和 facility（inventory/crafting_table）。offset 默认 0（0–10000）；limit 默认 8（1–32）。

引用为来源、版本、修订及原生配方内容的 SHA-256，不能跨物品/版本/配方变化复用。它标识知识，不证明材料充足、设施存在或服务器采用同一配方。

### recipe_evaluate：整批材料与设施评估

```json
{"type":"recipe_evaluate","item":"wooden_pickaxe","recipeRef":"<查询返回的64位引用>","count":1,"facilities":[]}
```

count 表示本次新增数量（1–2304）。按每次产量向上取整，返回原料 required/available/missing、missingFacility、batches、outputCount 和 craftable。库存读取当前 GUI 的背包区域，避免旧背包镜像。

facilities 默认空，仅接受 crafting_table，是规划假设；结果始终标明 facilityObserved=false。即使 craftable=true，也不能证明工作台存在或可达。实际制作仍检查设施方块和距离。

### requirements_expand：有界递归需求

```json
{"type":"requirements_expand","goals":[{"item":"wooden_pickaxe","count":1}],"mode":"total","facilities":[],"maxDepth":8,"maxNodes":128,"maxAlternatives":6}
```

- goals 包含 1–16 个目标，各数量 1–2304，重复物品目标会合并。
- mode 默认 total（最终持有量）；additional 表示新增量，会先保留原有目标物品。
- maxDepth 默认 8（1–16）、maxNodes 默认 128（1–512）、maxAlternatives 默认 6（1–32）。递归数量超过 100 万返回错误。
- 可传 recipeRefs（物品名到选定引用的映射）；失效引用报 STALE_RECIPE，未触及选择列入 unusedRecipeSelections。

结果包含候选 operations、missing、inventoryRemaining、reservedExisting、assumedFacilities、搜索截断标记、来源和访问数。operations 只表达 craft/place_facility，无世界坐标，executable=false，不会自动执行。

| status | 含义 |
|---|---|
| resolved | 找到当前库存和设施假设下材料依赖可满足的分支 |
| needs_resources | 选中分支仍有待获取资源或转换环 |
| incomplete | 深度/节点预算用尽，展开不完整 |

先按已有材料可达性排序，再有界尝试替代配方；跨分支预留库存、复用批次余量、只计一次工作台。没有全局最优保证；alternativesTruncated=true 表示有候选未搜索，选中分支缺料不证明所有方案均缺料。

目前只覆盖本地合成规则；熔炼/燃料、采集工具等级、返还容器、副产物与服务器自定义配方尚未完整建模。资源获取叶子交给上层规划，“本库无合成配方”不等于“游戏中不可获得”。

## LLM 与执行接线

统一决策入口新增 `{"kind":"query","query":{...}}`，仅允许上述三种只读查询。本轮结果通过结构化 knowledge 回传模型，模型随后选择 reply/skill/plan。最多 3 次知识查询、4 次模型调用，共享默认 12 秒决策预算；重复查询被阻断。

单条知识结果最大 6KB，总 JSON 上下文受默认 12KB 预算约束。超大结果返回 OUTPUT_TOO_LARGE，要求缩小 limit/maxNodes 或分页；不截成损坏 JSON。历史知识结果超预算时淘汰最旧项并标记 knowledgeTruncated。查询循环只存在当前 decide 调用中，不提供持久记忆；旧的无推理模型路由没有此循环。

craft、craft_output、craft_item 新增可选 recipeRef。未指定时保留首个可制作配方的兼容行为；指定时检查同一原生配方和整批材料，不静默换配方。

```json
{"type":"craft","item":"spruce_planks","repetitions":1,"recipeRef":"<查询返回的64位引用>"}
```

所有写操作仍走同一个调度器/控制器/动作执行器。craft 和 craft_output 共用 `src/crafting.ts`：先检查窗口/光标、设施及整批材料，发出一次原生合成，再对账并核对完整批次产量。

已安装 Mineflayer 提供 `_syncWindow` 时，结束后对玩家背包做一次同步，覆盖徒手合成末次点击可能仅为预测的情况；这是已核对的 4.39.0 内部接口，依赖升级需重新验证。无该接口时返回 reconciled=false，只依据客户端背包增量。不固定休眠，不自动重试。

失败结果保留 requestSent、apiComplete、reconciled、needsReconciliation、expected/gained 和前后库存，穿过动作执行器、动态技能与控制器供上层检查。CRAFT_API_FAILED/CRAFT_RECONCILIATION_FAILED 可能已有部分效果。取消后不再开始同步或后续操作；在途原生操作结束前仍占用租约。

这套时序只通过模拟验证，截图中的真实合成故障仍需服务器复测。递归查询不等于持续目标规划；P2 基本操作网关、P3 滚动规划和 P4 持久化见 [开发计划](basic-operations-long-horizon-plan.md)。
