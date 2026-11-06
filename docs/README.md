# 文档导航

**当前 sim-v2-9：** 单模型持续决策、可选阶段、统一观察引用；以 [当前大脑架构](brain-architecture.md) 和 [完整提示词](brain-prompts-review.md) 为准。旧文档的双角色/四角色及独立模型验收为历史设计。

当前默认入口：[大脑架构与路由](brain-architecture.md)；运行前按用户要求审阅 [完整大脑提示词](brain-prompts-review.md)。`pnpm prompts:export` 从运行注册表导出审阅包。默认 V2 已替代此前默认 legacy 的接线；旧文档中的“实验入口/待切换”是历史记录。

最新执行结构：[持续阶段执行](stage-execution.md)，含方案节点、结果绑定、数据流校验、事件中断、持久恢复与真实模型合成探针。

2026-11-03 最新接口：[配方摘要、材料检查与容器记忆](resource-knowledge.md)，含缓存、持久化、短配方编号、连续执行和验证边界。

下一版主线见 [Agent V2 设计](agent-v2-design.md)。首版实验模式已实现，启动方法、275 项测试和未实机验收的边界见 [V2 运行说明](agent-v2.md)。完整设计尚未全部落地。

运行排障优先看 [运行诊断界面](diagnostics.md)：启动方法、各环节含义、日志回放与验证边界。

当前 TypeScript 运行结构见 [agent.d2](../agent.d2)：总览及决策、执行、诊断三张细图，按实际装配维护；橙色标出现有限制，灰色说明尚未接入的能力。执行 `d2 agent.d2 dist/architecture/agent.svg` 渲染，或用 `--target layers.decision` 等选择细图。这是当前结构记录，不是下一版大脑设计。

## 推荐阅读顺序

1. [项目README](../README.md)：启动、调用和目录入口。
2. [当前进度](../PROJECT_STATUS.md)：已实现、已验证、未实现的事实。
3. [完整动作目录](actions.md)：参数、前置条件、证据和能力边界。
4. [二级技能库](skills.md)：动态技能契约、首批七个技能、失败条件与验证状态。
5. [决策循环设计记录](prompt-review-draft.md)：输入契约、DeepSeek 提示词、程序校验、反馈与目标上限。
6. [全链路实机测试手册](live-test.md)：真实 1.21.1 服务器与真实模型的执行步骤、验收和记录模板（尚未执行）。
7. [架构与CoCraftBench分析](cocraftbench-analysis.md)：分层理由和需求分析。
8. [开发路线](roadmap.md)：下一阶段工作与验收条件。
9. [基本操作与长程规划开发计划](basic-operations-long-horizon-plan.md)：近期 P0–P4 主线与验收条件（首轮配方基础已实施，整体计划未完成）。
10. [配方知识与精确制作](recipe-knowledge.md)：已实现的理论配方查询、递归需求、模型查询接线和指定配方制作（模拟验证）。
11. [基本操作与观测引用](basic-operations.md)：LLM 操作网关、引用生命周期、能力限制、模拟验证及只读实机探针结果。
12. [44 种模型操作完整目录](operation-catalog.md)：参数与 1.21.1/1.21.6 可用性，由 pnpm schema 生成。

## 文档与生成文件

|文件|用途|维护方式|
|---|---|---|
|actions.md|45个动作、12个查询的使用说明|随接口实现更新|
|basic-operations.md|模型基本操作与短期目标引用接口及验证边界|随接口与实机验证更新|
|operations.schema.json|44种模型操作的参数定义|pnpm schema 生成，不手改|
|operation-catalog.md|完整模型操作/参数/版本状态表|pnpm schema 生成，不手改|
|recipe-knowledge.md|知识查询、递归边界、配方引用与制作对账|随接口与验证进展更新|
|skills.md|动态技能契约、首批七个技能、失败码与验证状态|技能实现或验证结果变化时更新|
|gather-wood.md|gather_wood 的输入、流程、限制与试玩方式|采集行为变化时更新|
|prompt-review-draft.md|伙伴大脑决策循环的输入字段、DeepSeek 提示词、校验与反馈设计记录（已实现，模拟验证）|提示词、输入契约或反馈规则变化时更新|
|live-test.md|真实 Java 1.21.1 + 真实模型的端到端测试手册与记录模板（尚未执行）|实机步骤、失败判据或验证结果变化时更新|
|cocraftbench-analysis.md|固定源码版本的需求分析|修改结论时重新核对依据|
|roadmap.md|计划与验收条件|阶段推进时更新|
|basic-operations-long-horizon-plan.md|基本操作与长程规划的近期详细计划、查询数据源决策|按实施与验收进展更新，不把计划记为完成|
|actions.schema.json|动作参数的机器可读定义|修改src/schema.ts后执行pnpm schema，不手工修改|
|queries.schema.json|只读查询的机器可读定义|同上|
|cocraftbench-coverage.json|42个契约和100题的静态能力映射|修改scripts/analyze-cocraftbench.cjs后执行pnpm analyze:benchmark|
|cocraftbench-tasks.md|逐题可读对照表|同上，不手工修改|

静态映射不表示任务通过；JSON Schema不表示物理机制已经可用。当前验证状态统一查阅 [PROJECT_STATUS.md](../PROJECT_STATUS.md)。

## 参考源码与复现

CoCraftBench参考副本位于 `.reference/CoCraftBench`，固定提交为`be208787b6d1831c8897e42a505319c04db5923b`。它不是SIM运行时依赖，不修改其中的任务和判据。

`pnpm build`、`pnpm test`、`pnpm start`、`pnpm schema`不依赖该副本；重新生成benchmark映射需要它存在且提交一致。`.reference/`被Git忽略，因此未来新克隆SIM项目时，需要另行取得这个公开参考仓库的固定提交。参考版本变更后应先重新审查映射。
