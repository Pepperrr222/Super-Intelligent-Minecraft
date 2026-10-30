# 文档导航

## 推荐阅读顺序

1. [项目README](../README.md)：启动、调用和目录入口。
2. [当前进度](../PROJECT_STATUS.md)：已实现、已验证、未实现的事实。
3. [完整动作目录](actions.md)：参数、前置条件、证据和能力边界。
4. [架构与CoCraftBench分析](cocraftbench-analysis.md)：分层理由和需求分析。
5. [开发路线](roadmap.md)：下一阶段工作与验收条件。

## 文档与生成文件

|文件|用途|维护方式|
|---|---|---|
|actions.md|43个动作、5个查询的使用说明|随接口实现更新|
|cocraftbench-analysis.md|固定源码版本的需求分析|修改结论时重新核对依据|
|roadmap.md|计划与验收条件|阶段推进时更新|
|actions.schema.json|动作参数的机器可读定义|修改src/schema.ts后执行pnpm schema，不手工修改|
|queries.schema.json|只读查询的机器可读定义|同上|
|cocraftbench-coverage.json|42个契约和100题的静态能力映射|修改scripts/analyze-cocraftbench.cjs后执行pnpm analyze:benchmark|
|cocraftbench-tasks.md|逐题可读对照表|同上，不手工修改|

静态映射不表示任务通过；JSON Schema不表示物理机制已经可用。当前验证状态统一查阅 [PROJECT_STATUS.md](../PROJECT_STATUS.md)。

## 参考源码与复现

CoCraftBench参考副本位于 `.reference/CoCraftBench`，固定提交为`be208787b6d1831c8897e42a505319c04db5923b`。它不是SIM运行时依赖，不修改其中的任务和判据。

`pnpm build`、`pnpm test`、`pnpm start`、`pnpm schema`不依赖该副本；重新生成benchmark映射需要它存在且提交一致。`.reference/`被Git忽略，因此未来新克隆SIM项目时，需要另行取得这个公开参考仓库的固定提交。参考版本变更后应先重新审查映射。
