# 二级技能库（动态观察—执行—验证）

技能是面向玩家目标的可复用能力，不是一次性动作数组。一个技能可以连续观察、执行动作、验证结果并汇报进度，但只能通过控制器提供的同一个 `ActionPort` 执行动作；它不能直接持有 Mineflayer，也不能绕过单一动作租约。

首批七个动态技能已实现并通过模拟测试，**尚未在 Java 1.21.1 服务器逐项实机验证**。`follow_player`、`come_to_player`、`report_inventory` 仍是确定性技能，不在此次动态技能范围内。

## 契约与运行时

`src/skill-runtime.ts` 定义运行时基础设施：

- `SkillDefinition`：`id`、描述、输入/输出 schema、支持版本、风险、所需能力、是否幂等、`run(input, context)`。
- `SkillContext`：只暴露 `signal`、`deadline`、`player`、`check()`、`query()`、`execute()`、`report()`，并自动收集 `evidence` 和 `progress`。技能无法取得 Bot 或第二个执行器。
- `SkillResult`：`succeeded`、`failed`、`blocked`、`cancelled`、`partial`，带 `output`、`error`、`evidence`、`progress`、`partialEffects`。
- `SkillRegistry` / `SkillRunner`：注册、查找、输入 schema 校验、执行和结果归一化。运行器不排队、不重试、不选目标。
- `ActionController` 是唯一动作租约所有者；调度器决定何时执行以及失败后是否继续。技能只负责当前目标内的观察—执行—验证循环。

状态映射：`succeeded → ok`、`blocked → blocked`、`cancelled → cancelled`、`partial → partial`；截止时间映射为 `timeout`，动作端口返回 `busy` 时保留 `busy`，其余失败映射为 `error`。

每个技能成功后都必须给出可观察证据：导航复查最终位置，采集/拾取/制作/存入/交付复查背包或容器数量变化。**动作 Promise 完成不是成功条件。** 每条观察和动作结果都会进入 `evidence`；已完成的动作和技能声明的部分效果进入 `partialEffects`。

## 能力清单

状态分三列：已实现、模拟通过、实机通过。实机通过指在固定 Java 1.21.1 测试服上按技能输入完成任务并记录了结果；“模拟通过”不能替代实机验收。

| 技能 | 输入（默认值） | 成功证据 | 风险 | 已实现 | 模拟通过 | 实机通过 |
|---|---|---|---|---|---|---|
| `find_resource` | `names[]`、`radius=16`、`limit=32` | 返回已加载范围内的候选方块列表 | low | 是 | 是 | 否 |
| `navigate_to` | `x,y,z`、`range=2` | 结束时重新读取位置，floor 后与目标距离 ≤ `range` | low | 是 | 是 | 否 |
| `collect_drops` | `item?`、`count=1`、`radius=8`、`maxDrops=6`、`waitMs=600` | 背包目标物品（或总物品）增量 ≥ `count` | low | 是 | 是 | 否 |
| `gather_wood` | `woodType?`（八种原木，省略时自动选择）、`count=1`、`searchRadius=16` | 背包对应原木增量 ≥ `count` | requires_confirmation（仅风险标记） | 是 | 是 | 否 |
| `craft_item` | `item`、`count=1`、`table?`、`recipeRef?`、`searchRadius=16` | 背包产物增量 ≥ `count` | requires_confirmation | 是 | 是 | 否 |
| `store_items` | `container`、`item`、`count` | 背包减少 `count` 且容器增加 `count` | requires_confirmation | 是 | 是 | 否 |
| `deliver_to_player` | `item`、`count=1`、`player?`、`range=2` | 背包减少 `count`；**接收方是否拾取不可验证** | requires_confirmation | 是 | 是 | 否 |

## 各技能说明

### find_resource

只读查询 `find_blocks`，返回候选位置、感知范围和“是否为完整世界搜索”标志。它不选择目标，也不保证方块可到达、未被保护或属于可采集资源。查询未返回候选列表时失败码为 `OBSERVATION_UNAVAILABLE`。

### navigate_to

先读取 snapshot 计算距离；若已在范围内则不发动作，否则执行 `navigate`，结束后再次读取 snapshot。完成条件是“最终位置在目标范围内”，不是寻路 Promise 结束。

- `POSITION_UNOBSERVED`：开始时读不到位置为 `blocked`，结束时读不到为 `partial`。
- `DESTINATION_NOT_CONFIRMED`：动作结束但最终位置超出范围，`partial`。
- 原生导航失败（如 `GOAL_NOT_REACHED`）通过 `SkillRunError.actionStatus` 保留原始状态。
- 停止时不再发起新动作；控制器负责等待仍占用的原生操作释放，技能不会提前解锁。

### collect_drops

在当前客户端已加载的区块内查找 `name === 'item'` 的实体，按距离逐个导航接近、等待并核对背包增量。`item` 只用于验收数量，**不用于筛选掉落实体**：1.21.1 的实体观察不提供掉落物物品身份，因此无法保证接近的掉落物就是目标物品；单个不可达掉落物会等待后重试一次（掉落物可能还在下落），仍不可达则跳过并继续，最终仍以背包增量为准。

- `NO_DROPS_OBSERVED`：范围内没有观测到掉落物，`blocked`。
- `PICKUP_UNCONFIRMED`：接近后背包没有达到请求增量，`partial`。
- 取消在每次循环和接近动作前检查；取消时不再尝试后续掉落物。

### gather_wood

支持八种原木：`oak_log`、`spruce_log`、`birch_log`、`jungle_log`、`acacia_log`、`dark_oak_log`、`mangrove_log`、`cherry_log`。流程为：记录背包基线 → 原木和树叶分开查询 → 选择附近有树叶的原木确认树的位置 → 记忆树干水平范围 → 按距离接近目标所在水平位置的地面 → 重新读取目标方块 → 挖掘一块 → 调用共享掉落物拾取 → 复查背包增量 → 继续或退出。

- 未指定 `woodType` 时，会分别查询八种受支持原木及其树叶，选择候选最多的一种；数量相同时取更近的。选中树种在本次运行内固定，保证背包增量归属准确。
- 原木和树叶不再共用同一个 `find_blocks` 结果预算。树冠很大时，旧的合并查询会用树叶占满最近方块列表，只留下靠近底部的少量原木；现在原木查询只返回原木，确认树的位置后会围绕树干水平范围继续采集，不再要求每块原木都紧邻树叶。
- 显式指定树种但附近没有带叶候选时，返回 `NO_ELIGIBLE_TREE`，不会静默换成其他树种。
- 接近或挖掘失败（如 `GOAL_NOT_REACHED`、`OUT_OF_REACH`）只跳过当前这棵树，继续尝试同树种的其他树，最多跳过 6 棵；没有可接近或可挖掘的目标时返回 `NO_REACHABLE_TARGET`，不会误报成“附近没有树”。取消、超时和控制器 busy 不会按“树不可达”处理。
- 每次只处理一个目标；最多尝试 `count * 3` 次，另加最多 6 次跳过不可达树的预算。单次拾取未确认时继续采集下一个目标，连续两次未确认才以 `PICKUP_UNCONFIRMED` 结束。
- 成功后按背包中该原木的增量验收，已发生的采集写入 `partialEffects`。
- `INVENTORY_UNKNOWN`：读不到背包；`NO_ELIGIBLE_TREE`：附近没有带对应树叶的原木（有部分收获时为 `partial`）；`NO_REACHABLE_TARGET`：附近有树，但都无法接近或挖掘；`TARGET_CHANGED`：接近后方块已改变；`PICKUP_UNCONFIRMED`：已挖掘但没有观测到原木进入背包；`ATTEMPT_LIMIT`：达到尝试上限。
- 树叶邻近只是简易筛选，不识别玩家建筑、土地权限或整棵树结构；不自动选择/更换斧头，不检测背包满，也不跨区块搜索。
- 不会垫脚、攀爬或搭桥。树干高于交互距离后，剩余原木可能无法挖掘；被挖掉下半截的树干可能悬空，只能尝试附近其他树。每次查询最多处理 `searchRadius` 内最近的 128 块原木。当前不会假装这些限制不存在。
- 取消后不再挖掘或拾取；掉落物可能仍留在世界，技能不做回滚。取消后的背包复查只能尽力而为，因为上下文在 abort 后拒绝新查询。

### craft_item

通过 `recipes` 查询读取当前版本注册表中“材料已满足”的配方；若给定 `table`，先检查该坐标确实是 `crafting_table` 并导航过去；否则先尝试徒手配方，再在 `searchRadius` 内寻找附近工作台并复查。材料和产物数量在制作前后都从 snapshot 核对。

- 可用知识查询返回的 `recipeRef` 指定配方，技能与底层动作检查并执行同一配方；不指定时兼容使用 `recipes[0]`。理论配方与递归需求接口见 [配方知识](recipe-knowledge.md)。
- 计算 `repetitions = ceil(count / 每次产物数)`，按每次最多 64 次分批执行，每批后复查背包。
- `TABLE_NOT_OBSERVED` / `NOT_CRAFTING_TABLE`：指定位置不是工作台；`RECIPE_QUERY_FAILED`：配方查询失败；`NO_CRAFTABLE_RECIPE`：没有材料满足的配方；`INSUFFICIENT_MATERIALS`：材料总量不足；`CRAFT_OUTPUT_UNCONFIRMED` / `CRAFT_LIMIT_REACHED`：产物增量未达标（`partial` / `failed`）。
- 不支持递归制作中间产物、多配方偏好选择、自动合成台放置或背包满处理。
- 取消后不再开始下一批制作；已经发出的制作请求可能已产生部分产物，运行器会把已成功动作记入 `partialEffects`。

### store_items

读取背包确认物品足够，调用 `container_inspect` 读取容器基线，再执行 `container_transfer`（deposit），最后同时复查容器和背包。完成条件是“背包减少 `count` 且容器增加 `count`”。

- `INSUFFICIENT_ITEMS`：背包不足，`blocked`。
- `TRANSFER_MISMATCH`：动作完成但两侧数量不符合预期，`partial`。
- 容器坐标必须由玩家消息或计划目标提供，技能不自动寻找箱子；容器被其他玩家同时修改时可能报告不匹配。

### deliver_to_player

目标默认为当前请求玩家（`ctx.player`），也可显式指定 `player`。技能最多尝试两次接近：读取玩家实体、导航到其位置、重新观察；进入范围后执行 `toss`，再核对背包减少量。

- `NO_DELIVERY_TARGET`、`POSITION_UNOBSERVED`、`INSUFFICIENT_ITEMS`、`PLAYER_NOT_OBSERVED`、`PLAYER_LOST`、`PLAYER_UNREACHABLE`：无法开始交付。
- `TRANSFER_MISMATCH`：背包减少量不等于请求数量，`partial`。
- 输出固定包含 `receipt: 'unverified'`。客户端只能证明物品离开机器人背包、玩家当时在附近，**不能证明对方已拾取**；这不是交易，也没有服务端回执。
- 丢出前取消报告 `tossed: 0`；丢出请求发出后取消报告 `tossed: null` 并在 `partialEffects` 中说明无法确认背包变化。取消不是回滚。

## 接入方式

- `src/builtin-skills.ts` 注册七个动态技能，`DEFAULT_SKILLS` 由控制器和调度器共享。
- `src/skills.ts` 的 `SkillCatalog` 登记同名技能；小模型意图路由、规划器和决策循环的技能卡都从同一注册表/目录生成。
- `navigate_to` / `store_items` 的坐标、`craft_item.table` 的坐标和 `deliver_to_player.player` 必须出现在玩家消息或计划目标中，否则请求澄清，不能由模型凭空生成。决策循环由 `DecisionValidator` 再次检查 grounding。
- `gather_wood`、`craft_item`、`store_items`、`deliver_to_player` 仍标记 `requires_confirmation` 风险，表示会修改世界或消耗物品；但决策循环不再生成“回复确认”环节，技能/计划通过程序校验后直接开始。`find_resource`、`collect_drops`、`navigate_to` 不标记该风险。
- 模型不能用 `skill`/`plan` 跳过 `DecisionValidator` 的注册表、参数、grounding、占用和权限校验；交互层仅为外部端口保留确认分支。模型可以在玩家明确要求时用 `control.cancel` 结束当前任务，或用 `replaceCurrent` 声明替换；两者都只对 owner 自己的活动任务生效，并由程序调用调度器。
- 技能结果进入控制器回执和任务数据；调度器仍负责排队、依赖、优先级、暂停/取消和失败后的策略。

## 中断与恢复

- 每个技能启动时重新读取 snapshot 建立基线，不复用上一次执行的内存结果。
- 停止通过 `AbortSignal` 传给上下文和动作端口；技能在循环和动作前检查，取消后不再发起新查询或动作。若底层原生操作仍占用租约，控制器等待其结束，不提前解锁。
- 已经发生的效果保留在 `partialEffects` 和 `evidence`；取消不是回滚。恢复前必须重新观察世界和背包，不能假设任务从零开始。
- 技能不会自动断点续跑。调度器重启时把上次 `running` / `cancelling` 任务标为 `blocked`，要求对账后显式 resume；当前没有技能级世界对账器，恢复前需要人工检查背包、容器和方块状态。

## 验证现状

2026-11-01 最新基线：编译通过，**235 项测试通过，0 项失败**。新增 17 项配方查询/递归/精确制作/模型查询测试见 [配方知识](recipe-knowledge.md)；此前 218 项中与动态技能直接相关的包括：

- `test/skill-library.test.ts`：28 项，覆盖七个技能的正常完成、受阻和取消/中断、掉落物下落重试，以及目录登记、自动开始、规划器坐标 grounding 和配方选择一致性。
- `test/skill-runtime.test.ts`：8 项，覆盖 runner 输入校验、未知技能、预取消、证据归一化，以及 `find_resource`、`store_items` 和控制器执行。
- `test/gather-wood.test.ts`：10 项，覆盖正常采集、自动选择附近树种、树冠不挤占原木查询、显式缺失树种不回退、跳过不可达树并继续采集、无可达目标、拾取未确认、目标变化和取消后不挖掘。
- 底层导航测试新增 1 项，确认导航后置检查与 pathfinder 的到达判据一致：脚部取整节点或其上方一格在 range 内都算到达，雪层/台阶不会造成假 `GOAL_NOT_REACHED`；真正的超距仍失败。
- `test/brain-feedback.test.ts`：10 项，覆盖七个技能输出如何变成 `RunFeedback`、哪些变化才算 `verified`、取消/部分/超时的确定性文本。
- `test/brain-decision.test.ts`：17 项，覆盖决定解析、技能可用性/参数/grounding/自动开始/权限/任务占用/终态任务不占用/模型取消/显式替换/重复失败和计划规则。
- `test/decision-loop.test.ts`：17 项，覆盖任务执行、验收反馈、有界跟进、完成/取消/重规划、blocked 不阻塞新目标、模型取消/替换运行中的任务、重复失败阻断、停止中止、待澄清清理、任务占用和新消息抑制旧跟进。
- 其余为上下文与目标、底层动作、执行器、调度器、控制器、交互、LLM 与端到端模拟测试。

这些测试使用模拟 Bot、假 `ActionPort`/Transport/LLM，验证的是状态机、取消和观测接口，不验证真实寻路、区块加载/卸载、服务器反作弊、方块保护、掉落物归属、网络延迟或背包满等实际机制。

实机验证仍为 `not_run`。建议按 `find_resource → navigate_to → collect_drops → gather_wood → craft_item → store_items → deliver_to_player` 的顺序，在固定 Java 1.21.1 测试服逐项记录：服务器版本、初始位置/背包、输入参数、动作与观测结果、最终世界/背包状态、取消清理和失败原因。只有完成这些记录后，才能把对应技能的“实机通过”改为“是”。

## 尚未实现

- 背包满、工具耐久/工具选择、方块保护/领地权限、掉落物归属与过期处理。
- `gather_block` 的通用方块采集（当前只有 `gather_wood`）；熔炼、耕种、建造、战斗、探索等类别仍是路线图内容。
- 箱子自动定位、交付回执/交易 GUI、技能间输出传递和技能级自动重规划。决策循环只在目标层做有界重规划（最多 2 次），不会把上一步输出传给下一步。
- 真实服务器实机验收和技能级性能/稳定性数据。
