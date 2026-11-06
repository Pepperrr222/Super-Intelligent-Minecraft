# LLM 基本操作与观测引用

2026-11-05：V2 使用单模型 decision，动作输出为 `kind:propose`；下文 `kind:operations` 属于 legacy。`snapshot.entities[].ref`、`find_blocks.blocks[].ref`、已加载范围内 `inspect_block.ref` 与 `observe_targets.targets[].ref` 使用同一个引用注册表。不要把数字实体 id/实体 uuid 用作 targetRef。引用默认 30 秒有效，重复观察不延长旧引用寿命，过期后重新观察获得新引用。

掉落物按内容查询：`{"type":"observe_targets","itemNames":["spruce_log","iron_ingot"],"radius":16,"limit":16}`；所有掉落物含身份未知者使用 `entityKinds:["item"]`；玩家使用 `entityKinds:["player"]`，可结合 `entityNames`。实体过滤字段隐式开启实体观测，多项实体过滤取交集。`blockNames` 与旧 `names` 合并后只查询方块，和实体查询共享 limit；目标过多时分别查询。空结果只代表当前加载范围内未匹配。

2026-11-02 更新：当前 45 动作、12 查询、275 项自动测试；模型关键意图参数改为显式必填，新增本地 position 引用、手持与掉落物身份观察，见 [V2 运行说明](agent-v2.md)。下文 251 项/11 查询为此前基线。

状态：2026-11-01 扩展为全部 44 种原生动作的模型操作入口。251 项自动测试通过；尚无完整实机任务验收。当前为 45 种底层动作（含 operate 网关）和 11 种只读查询。1.21.1 可调用 41 种操作，三种酿造槽位接口仅适配 1.21.6；1.21.6 可调用 43 种，下乘因已知输入包限制禁用。默认项目目标仍为 1.21.1。

## 完整目录与可用性

[44 种操作完整参数/版本目录](operation-catalog.md) 和 [机器可读 Schema](operations.schema.json) 均由 `pnpm schema` 生成。模型每轮收到 operationCatalog（全部动作、可用状态和不可用原因）与 availableOperations（当前允许名单），按需查询精确参数：

```json
{"kind":"query","query":{"type":"operation_schema","types":["move_ticks","look_at_entity"]}}
```

types 每次 1–4 项；结果过大时每次只查一项。这样不用把 44 份完整 Schema 塞进每一轮上下文，也不把暂不可用动作隐藏。可用状态受版本和配置的 capabilities 限制，不表示材料、工具、设施、距离或其他前置条件满足，更不表示实机验收通过。

操作定义复用原生 Action Schema 中的参数与枚举，针对坐标、实体、物品和报价转换成短期引用。回归检查 44 个原生动作和 44 个模型操作一一对应，新动作遗漏会触发检查失败。

所有参数 JSON Schema 采用输入模式：带默认值的字段可省略，craft 的 count/repetitions 互斥要求同时写入机器可读 Schema；按需查询和生成文件使用同一转换函数。

## 统一调用

模型可返回下面的批次，程序按 schema、owner、版本、能力、任务占用及重复失败记录校验，再交给 TaskScheduler → ActionController → MinecraftActions → ActionExecutor。每个操作编译成一个 operate 动作，引用在取得同一动作租约后解析；没有第二个 Bot 控制器。每批最多 4 个操作，总截止时间沿用决策预算；底层不会自动选工具、导航、重试或补材料。

```json
{"kind":"operations","goal":"放置工作台","operations":[
  {"type":"equip","item":"crafting_table","destination":"hand"},
  {"type":"place","targetRef":"<观测返回的UUID引用>","item":"crafting_table","face":"up"}
]}
```

程序调用可以使用 `actions.execute({type:'operate',operation:{...}})`；模型调用的权限校验仍在决策层。所有操作参数以 `src/schema.ts` 的 basicOperationSchema 为准。下表保留首批常用操作，其他动作及参数见完整生成目录。

| type | 参数 | 目标/结果语义 |
|---|---|---|
| navigate | targetRef, range=2（0–4） | 走到本次解析的目标位置附近，实体移动后不会持续跟随 |
| look_at | targetRef | 看向本次解析的位置，非持续追踪 |
| dig | targetRef | 单块挖掘；不等于掉落物已入背包 |
| place | targetRef, item, face=up | 支持 placement 引用（上表面）或 block 支撑引用加任意六面；复查目的地占据及最终方块名 |
| equip | item, destination=hand | API 结束后复查实际手持/装备槽 |
| unequip | destination | API 结束后复查实际槽位为空 |
| craft | item, count/repetitions, recipeRef, tableRef? | 新增产物数量和配方次数二选一；使用指定配方，沿用整批材料预检和对账 |
| container_inspect | targetRef | 开窗读取并关闭，属于占租约的原生窗口操作 |
| container_transfer | targetRef, direction, item, count | 一次存/取，结果仍以底层证据为准 |
| furnace_inspect | targetRef | 查看熔炉当前槽位与进度 |
| furnace_put | targetRef, slot, item, count | 装料或燃料，不代表熔炼完成 |
| furnace_take | targetRef, slot, expectedItem, minCount=1 | 等到阈值后取整堆，遵守原有超时与取消 |

新增开放移动/物理刻控制、视角与实体部位、跟随、选槽、持用/食用、方块/实体交互、攻击、丢弃、等待/条件等待、实体放置、背包整理、酿造、交易、附魔、铁砧、钓鱼、上下船与载具输入、自然语言聊天等全部已有原生类型。底层版本限制、玩家攻击保护、自然语言聊天过滤和不可中断原生 Promise 的租约规则保持有效。拾取继续使用 collect_drops 技能；旧 skill/plan 入口保留。1.21.1/1.21.6 之外的版本暂不开放此网关。

capabilities 可使用 move/look/navigate/equip/craft/container/furnace/brewing/trade/wait 等族名；未归族的动作使用其 type 名称。缺少对应能力时目录给出明确原因。稳定快捷栏序号 select_slot.slot（0–8）、酿造目标 destinationSlot（0–4）仍可由模型明确指定。

## 物品、报价与工作站引用

```json
{"kind":"query","query":{"type":"observe_inventory","offset":0,"limit":8}}
```

按背包 36 个主背包/快捷栏位置分页，offset 默认 0（0–36），limit 默认 8（1–16），返回 items 的 itemRef、空槽 emptySlots 的 destinationRef 及 nextOffset；不返回内部槽位编号、指纹、NBT 或组件。打开 GUI 时使用窗口中的当前背包映射。

- inventory_move 使用 sourceRef/destinationRef；enchant 使用工作站 targetRef 和物品 itemRef；anvil 还可指定 secondRef。
- trade_inspect 保持原生开窗动作与租约，返回脱敏报价和 offerRef；trade 必须使用同一 targetRef 下的 offerRef，原生执行端会重新匹配完整报价，价格变化仍会失败。
- brewing_inspect 在 1.21.6 返回 contents 的角色、物品摘要和 itemRef；brewing_put 使用背包 sourceRef 和明确的 destinationSlot；brewing_take 使用检查返回的 itemRef，内部保留槽位指纹。
- 报价和物品引用每 Bot 最多 512 项、30 秒有效；清理时机与世界目标引用一致。数量、属性、位置、作用域或空槽占据变化会使引用失效，不会按同名物品悄悄替换。
- 反馈压缩保留完整、可解析的报价引用和 targetRef，并明确 limited；不会截断成无法使用的 JSON 字符串。大量报价仍需重新检查，引用不提供跨进程恢复。

## 观测与引用

模型在同一轮只读查询循环中使用：

```json
{"kind":"query","query":{"type":"observe_targets","names":["crafting_table"],"placements":false,"entities":false,"radius":8,"limit":8}}
```

names 默认为空、最多 16 个方块名；radius 默认 8（1–16）、limit 默认 8（1–16），placements/entities 默认 false。返回 scope、completeWorldSearch=false、targets、limited 和 ttlMs。单个目标只含 ref、kind、name、position、observedAt、expiresAt，不包含实体 ID/UUID、NBT、槽位或原始状态。

- block 来自客户端已加载范围内的方块查询。
- entity 来自当前附近实体，按距离排序；引用复查实体对象身份，防止 ID 被复用。
- placement 枚举机器人脚部整数高度附近水平 ±2 格、有完整方块支撑的空气格，并保守避开实体占据的位置。它不是任意地形上的完整放置规划器，也不证明领地权限或射线无遮挡。
- 合并查询先列方块，再列放置候选和实体；达到 limit 时 limited=true。需要某一种候选时单独查询，避免被其他类别占满。

引用使用不可推断位置的 UUID，保存在每个 Bot 的注册表，最多 256 项，30 秒有效。执行时再次检查期限、维度、游戏版本、观测距离、方块状态或实体身份；放置还检查空气、支撑和占据情况。死亡、出生、维度改变与 dispose 会清空引用。过期/伪造/其他 Bot 的引用不会变成坐标继续执行。

错误包括 UNKNOWN_TARGET_REF、EXPIRED_TARGET_REF、STALE_TARGET_REF、TARGET_NOT_OBSERVED、TARGET_KIND_MISMATCH、PLACEMENT_CHANGED。需要重新观察后决策，程序不悄悄更换目标。

工作台放置前只有 placement 引用；放下后原空气引用失效，必须重新 observe_targets 获取 block 引用，才能作为 craft.tableRef。由此在批次之间形成真实观测屏障，不允许预先绑定尚不存在的世界对象。

模型查询仍遵守每轮最多 3 次查询/4 次模型调用及默认 12 秒、12KB 总预算。knowledge 可以包含配方知识、目标/物品观测或操作参数 Schema，它们的来源与时效不同。queries 不提交写任务，operations 不执行任意代码。

## 验证与阶段边界

新增模拟回归涵盖引用脱敏/过期/跨 Bot/目标变化、支撑与手持检查、实体身份复用、严格 schema、owner/版本/能力/占用/重复失败、取消时保留原生租约以及装备真实后置检查。

本轮追加 7 项回归：全 44 项目录与绑定覆盖、物品引用、报价脱敏及结构化反馈、移动清理/聊天过滤、跨维度等待和 Schema 查询接线。原有 244 项与新增 7 项共 251 项通过。这些检查不代表 44 种真实玩法已经逐项实测。

完整切片测试经过真实 1.21.1 本地配方数据和模拟 Bot，依次完成“原木 → 木板 → 工作台 → 装备 → 放置 → 重新观察 → 木棍 → 木镐 → 装备”。模型、世界效果均为模拟；测试驱动器显式请求两个操作批次，不代表 P3 自动持续目标已实现。

2026-11-01 只读实机探针使用已配置的本机离线测试服和独立测试用户名。普通执行环境首次连接 EACCES；放开环境限制后客户端出生，报告版本 1.21.1，但出现协议解码跳包告警，目标查询返回 0 个可复查候选。结果为未通过，不能宣称引用实机验收，更没有执行完整写任务；根因尚未定位。记录保存在忽略目录 `logs/basic-operations-probe.json`。

复现只读探针：先 `pnpm build`，再 `node scripts/probe-basic-operations.mjs`。它读取本地连接配置或 MC_* 环境变量，仅支持 offline 测试服；不聊天、不发移动控制、不制作或改变方块。无需打印连接地址或账号资料。

本阶段已交付网关与引用原型。后续先排查实机协议和观测问题，再按 [实机手册](live-test.md) 验证基本操作；P3 持续目标循环与 P4 持久化仍未实现。
