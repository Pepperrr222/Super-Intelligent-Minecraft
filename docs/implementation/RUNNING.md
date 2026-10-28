# 两层原版 Agent 运行说明

此文件说明当前新路径；完整目标见[实现手册](VANILLA_AGENT_V1.md)，实际验证进度见[PROGRESS.md](PROGRESS.md)。发布门槛未全部通过前默认legacy，新路径显式启用。

## 启动

在仓库根目录运行：

```powershell
.\.venv\Scripts\python.exe scripts/dev.py run --config config.json --orchestration hierarchical --dashboard
```

只覆盖本次进程，不改原配置。原有Node路径、Minecraft地址、用户名、密钥生效。learning.mode须B0；rules和goal-json仅用于显式legacy基线，不自动回退。

持久启用可在自己的配置增加 `"orchestration":{"mode":"hierarchical"}`，其他参数见实现手册12节。缺该对象默认legacy。

复合任务包含约定审查、两层决策、状态验收和报告审查，调用次数比旧路径多。专用验收配置为90次工具、60次模型、600秒活动时间和4096输出token；这不是最低要求或成功保证。开启供应商思考需为思考和最终JSON共同留足输出额度。不得静默提高用户预算。

## 聊天

- `!agent 描述你所处的环境`：基于实际观察回答，不建假位置目标。
- `!agent 不要移动，告诉我周围玩家和背包物品`。
- `!agent 停止`：整树取消，不等LLM。
- `!agent 纠正 改放坐标10 -60 0的箱子，其他不变`：保留真实进展，完成剩余工作。
- `!agent 回答 ...`：消费当前问题，保留原任务。
- `!agent 继续 <root_task_id>`：现场核对后显式恢复interrupted任务；不能复活已取消/终结任务。

owner=`*`时三人共享一项任务，均可停止/纠正/回答。暂停与中断也占会话，新普通任务提示先处理原任务；没有队列。停止等待中的问题后，旧答案无效。

## 持久化与恢复

runtime_dir下tasks.sqlite3保存根任务、版本、阶段、基线、证据、动作日志、报告与分段回执。模型文本仍按model-calls归档；任务存储与学习库分开。

启动识别interrupted，不自动执行。已确认结果从日志恢复；未知非幂等效果需核对，不能假设未发生。未知聊天回执也不保证玩家端去重。不要删库来掩盖不确定副作用。

预算在请求前持久化。崩溃恰逢模型等待时，无法知道准确崩溃时间：恢复保守扣该次调用预留上限，并记录recovery_budget_reservation_charged，不把整个离线时长计入任务。根预算不重置。

## 面板与感知

显示需求、阶段依赖/状态、计划原因、预算、报告与交付。选择器标注Coordinator/Worker/Reviewer、阶段与调用序号。Reviewer是支持性语义审查，不能覆盖失败的程序验收。

感知限于后端实际提供的坐标、维度、库存、健康/饥饿、附近玩家及有界查询。尚未新增地形全景/群系扫描；必须说明观察边界。

## 验证入口

```powershell
.\.venv\Scripts\python.exe scripts/dev.py test
.\.venv\Scripts\python.exe scripts/dev.py demo --output runtime/legacy-demo-check
.\.venv\Scripts\python.exe -m sim_agent.app.hierarchical_demo --output runtime/hierarchical-demo-check
.\.venv\Scripts\python.exe scripts/dashboard.py --runtime-dir runtime/hierarchical-demo-check --port 8767
```

两层demo为SCRIPTED_MOCK_ONLY，跑实际调度/控制/验收/交付，没有云模型或Minecraft，脚本角色不计作真实API调用。

已有本地两供应商配置、项目实验服官方server.jar与已接受EULA时：

```powershell
.\.venv\Scripts\python.exe scripts/hierarchical_acceptance.py --cases N01 N09 P01 --providers deepseek siliconflow
```

脚本新建服务器目录、存档和回环随机端口，只清理自己创建的进程；管理fixture与Agent能力隔离。完整失败与模型输出留runtime。源码变化中的开发批次不是冻结发布证据。完整场景见[验收矩阵](VANILLA_ACCEPTANCE.md)。

仅原版已有动作；攻击、放置、任意代码、学习和整合包延期。未知效果优先保守停止，不能保证任意崩溃自动恢复。语义审查不是普遍正确性证明，少数成功也不代表通用生存能力。
