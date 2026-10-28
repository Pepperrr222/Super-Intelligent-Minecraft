# 文档导航

文档分为当前设计、当前状态与问题、历史计划。设计手册不意味着功能已经通过实机验收。

## 当前开发入口

| 顺序 | 文档 | 用途 |
| --- | --- | --- |
| 1 | [实施进度](implementation/PROGRESS.md) | 当前版本、实现范围和验证状态 |
| 2 | [已知问题](implementation/KNOWN_ISSUES.md) | 最新任务证据与未解决问题 |
| 3 | [Coordinator 自主规划修订](implementation/COORDINATOR_AUTONOMY.md) | 当前两层职责、业务契约与 Worker 验收编译 |
| 4 | [两层运行说明](implementation/RUNNING.md) | 启动、多人聊天、恢复和预算 |
| 5 | [系统架构](ARCHITECTURE.md) / [动作协议](PROTOCOL.md) | 实现模块与 Python / Node 边界 |

当前设计修订优先于旧手册中 Reviewer 和底层验收编写的规定。需求变更仍遵守根目录 [协作约定](../AGENTS.md)：先讨论、再设计，由用户敲定修改。

## 使用与维护

- [零模型单动作调试](ACTION_DEBUG.md)：独立测试采集、移动、停止，不进入模型规划。

- [安装与开发](DEVELOPMENT.md)
- [DeepSeek / SiliconFlow 配置](MODELS.md)
- [规划面板](DASHBOARD.md)
- [能力与验收边界](VALIDATION.md)
- [开发与验收脚本导航](../scripts/README.md)

## 设计背景与交接

- [原始题目和开题 PPT](design/)
- [初版详细实现手册](implementation/VANILLA_AGENT_V1.md)：整体实施背景，冲突部分以当前修订为准。
- [交接提示词](implementation/LLM_HANDOFF.md)：同时提供当前进度、已知问题和架构修订。
- [验收矩阵](implementation/VANILLA_ACCEPTANCE.md)：计划场景不等于已经通过；涉及旧 Reviewer 的项目需按当前职责修订后使用。
- [历史实施记录](implementation/archive/PROGRESS_2026-10-28.md)：保留原始开发笔记，不作为当前状态。
- [研究路线](ROADMAP.md) / [实验约定](../benchmarks/README.md)：学习和整合包工作后置。

真实密钥、个人配置、完整运行日志和游戏存档留在本机，不纳入文档归档。
