这三种能力不要都加在 `brain` 里。按现在的 [agent.d2](D:\Projects\SIM\agent.d2) 结构，落点其实是三组：

| 能力 | 主要改哪里 | 新增什么 | 不要动什么 |
|---|---|---|---|
| 长程规划/调度 | `brain` + `scheduler` | `planner`、`task_graph`、`ledger`、`recovery` | `controller`/`move` 的动作语义 |
| 自我学习 | 新增 `memory`、`skills`；`brain.reflector` | 记忆、技能库、经验回写 | 底层动作实现 |
| 改造能力 | `move` 的 capability registry；代码 `schema/actions` | 能力清单、校验、版本 | `brain` 的规划逻辑 |

目前 SIM 已有底层动作库，以及 `TaskScheduler` + `ActionController` + `InteractionService` + `CompanionBrain` 的最小闭环；brain 可选接入 DeepSeek LLM 做规划和回复，但意图分类仍是规则版。持久账本、长程规划、记忆和技能库还没实现（见 [PROJECT_STATUS.md](D:\Projects\SIM\PROJECT_STATUS.md)）。上层能力仍应新增模块，不要塞进动作层。

## 1. 长程任务调度规划

分工要清楚：**`brain` 决定“做什么/为什么”，`scheduler` 决定“何时/按什么顺序/失败怎么办”**。

`brain` 内部加：

- `goal_manager`：多目标、优先级、截止时间。
- `planner`：把目标分解成任务图，带依赖、里程碑、成功条件。
- `replanner`：阻塞或失败时重规划。
- `critic`：任务后验收，不把“动作成功”当成“任务完成”。

`scheduler` 内部加：

- `task_graph`：依赖、并行、里程碑。
- `queue` / `stages`：现有队列和阶段机。
- `ledger`：持久任务账本，记录 `task_id`、`plan_revision`、步骤状态、幂等键、部分效果。
- `recovery`：重试、补偿、恢复。

再加一个 `world_model`（当前世界信念），和 `memory` 分开：

- `world_model`：当前位置、背包、附近方块/实体、已知地图。
- `memory`：过去经历、玩家偏好、地标、任务结果。

关键接口：

```text
brain -> scheduler: plan.request
scheduler -> brain: plan.status / replan.request
scheduler <-> ledger: 持久化 / 恢复
scheduler -> controller: skill / action command
controller -> scheduler: result / partial effects
move -> world_model: 观测
brain <-> world_model: 读取 / 更新
```

不要把 `planner` 写进 `scheduler`，也不要把 `queue` 写进 `brain`。

## 2. 自我学习（memory、skill）

新增两个顶层存储 + 一个反思器：

- `memory`（圆柱）：working / episodic / semantic / procedural。
- `skills`（注册表）：`skill id`、版本、参数 schema、前置/后置条件、步骤、成本、成功率。
- `brain.reflector`：任务后归因，写记忆，提出技能候选。

学习闭环：

1. `scheduler`/`controller` 产出带证据的结果；
2. `memory` 存 episode；
3. `reflector` 总结成功/失败原因；
4. 技能归纳提出候选；
5. validator 在模拟/回放中验证；
6. 通过后升入 `skills`，带版本和统计。

图的连接：

```text
brain <-> memory: 检索 / 写入
brain <-> skills: 选择 / 查询
scheduler -> memory: 任务结果 / 经验
controller -> skills: 加载技能
reflector -> memory / skills: 经验 / 候选
```

关键原则：**一次成功不固化技能**；至少多次可复现、通过验证，才升级为技能。

## 3. 改造能力（增加底层接口）

分两层，不要混：

- **技能级扩展**：用现有动作组合新技能；不改代码，只注册 `skills`，经过 schema/验证。
- **接口级扩展**：新增底层动作/查询；必须改代码、测试、审批。

`move` 增加 `capability_registry`：

- 清单字段：`id`、`version`、`kind(action/query)`、`params schema`、`permissions`、`mcVersion`、`mineflayerVersion`、`evidence`、`cost`。
- `controller` 只调用已注册能力；`brain`/`planner` 只看到清单；`interactor` 可以回答“你会什么”。

代码落点：

| 要加的东西 | 代码位置 | 备注 |
|---|---|---|
| 新动作参数 | [src/schema.ts](D:\Projects\SIM\src\schema.ts) | zod discriminated union |
| 新动作实现 | [src/actions.ts](D:\Projects\SIM\src\actions.ts) 的 `run` switch，或 [src/extensions.ts](D:\Projects\SIM\src\extensions.ts) 的 `runExtension` | 保持单一 executor |
| 新只读查询 | [src/schema.ts](D:\Projects\SIM\src\schema.ts) + [src/observation.ts](D:\Projects\SIM\src\observation.ts) | 不占动作租约 |
| 执行租约 | [src/executor.ts](D:\Projects\SIM\src\executor.ts) | 所有写操作仍走同一个 |
| 动作文档/JSON Schema | [docs/actions.md](D:\Projects\SIM\docs\actions.md) + `pnpm schema` | 生成物不手改 |
| 测试 | `test/` | 模拟 Bot，覆盖参数/证据 |
| 调度/记忆/技能 | 新上层模块 | 不塞进 `src/actions.ts` |

扩展流程：

```text
提案（schema + 实现 + 测试）
→ 静态校验
→ 模拟测试
→ 人工/策略审批
→ 注册 capability
→ 版本化 rollout
→ 监控 / 回滚
```

**LLM 不应直接改 `src/actions.ts`**。它只能产出提案；运行时的“自我改造”最多是加载审核过的技能/插件，不是任意写文件。若要做运行时插件，必须进程隔离、权限限制、版本固定。

## 4. 建议顺序

1. 先加 `memory` + `ledger`（数据基础）。
2. 再加 `planner` + `task_graph`（长程规划）。
3. 再加 `skills` + `reflector`（自学闭环）。
4. 最后加 `capability_registry` + 扩展流水线（改造能力）。
5. 自动技能归纳/代码生成放最后，不要一开始就做。

## 5. 一句话

**长程规划改 `brain`/`scheduler`；自学加 `memory`/`skills`/`reflector`；改造加 `capability_registry` + schema/test 流水线。`controller`/`move` 的动作语义保持稳定。**

`scheduler`/`controller` 的结构已经落入 [agent.d2](D:\Projects\SIM\agent.d2)，并开始有 `src/scheduler.ts`、`src/controller.ts` 的最小实现；`memory`、`skills`、`world_model` 和对应的边仍待后续加入。