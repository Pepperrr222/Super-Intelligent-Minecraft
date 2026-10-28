# 脚本导航

从仓库根目录运行。日常入口尽量使用 dev.py；保留原脚本路径，避免破坏已有命令和引用。

## 日常开发与查看

| 入口 | 用途 | 是否调用云模型 |
| --- | --- | --- |
| dev.py check | 检查 Python、Node、配置和执行器依赖 | 否 |
| dev.py test | Python 与 Node 本地回归 | 否 |
| dev.py demo | 原有离线 Mock 基线演示 | 否 |
| dev.py run | 启动 Bot，新架构需 --orchestration hierarchical | 默认 LLM 模式会调用 |
| dashboard.py | 查看本地任务和模型输出记录 | 否 |
| probe_model.py | 验证模型接口连接 | 会调用，可能计费 |

新版业务协议离线演示入口为 Python 模块 sim_agent.app.hierarchical_demo，需 PYTHONPATH=src。命令见 [架构修订](../docs/implementation/COORDINATOR_AUTONOMY.md)。

## 游戏测试服与验收

| 入口 | 用途 |
| --- | --- |
| setup_lab.py / lab_server.py / server.ps1 / server.sh | 隔离测试服准备、管理和启动，可能下载资源并写入测试世界 |
| smoke_executor.py | 执行器连接检查 |
| live_tasks.py / live_chat.py | 真实游戏任务与聊天联调 |
| live_acceptance.py | 既有原版动作与执行层验收 |
| cloud_acceptance.py | 既有云模型验收，会调用付费接口 |
| hierarchical_acceptance.py | 两层云模型开发验收，会调用付费接口；不能作为已通过的发布证明 |
| export_acceptance.py / export_cloud_acceptance.py | 从既有记录导出摘要 |
| fixture_commands.txt | 手动布置测试场景的指令参考 |

脚本参数以其 --help 和 [开发说明](../docs/DEVELOPMENT.md) 为准。阅读导航不会启动测试；真实验收与日常无费用本地检查分开。

原始运行记录保留在配置的 runtime_dir 或 runtime/ 中，不随整理删除、不提交 Git。历史摘要在 benchmarks/results/，与当前架构的完整实机验收分开。
