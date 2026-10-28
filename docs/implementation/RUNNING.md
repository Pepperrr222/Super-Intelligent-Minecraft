# 两层原版 Agent 运行说明

此文件说明当前新路径；完整目标见[实现手册](VANILLA_AGENT_V1.md)，实际验证进度见[PROGRESS.md](PROGRESS.md)。发布门槛未全部通过前默认legacy，新路径显式启用。

## 启动

在仓库根目录运行：

```powershell
.\.venv\Scripts\python.exe scripts/dev.py run --config config.json --orchestration hierarchical --dashboard
```

只覆盖本次进程，不改原配置。原有Node路径、Minecraft地址、用户名、密钥生效。learning.mode须B0；rules和goal-json仅用于显式legacy基线，不自动回退。

持久启用可在自己的配置增加 `"orchestration":{"mode":"hierarchical"}`，其他参数见实现手册12节。缺该对象默认legacy。

当前只调用 Coordinator 和 Worker，没有独立 Reviewer。最高层描述自然语言完成标准，Worker 编译程序验收；具体协议见 [架构修订](COORDINATOR_AUTONOMY.md)。复合任务包含两层决策、Worker 验收编译和状态核对，调用次数仍可能比旧路径多。专用验收配置为90次工具、60次模型、600秒活动时间和4096输出token；这不是最低要求或成功保证。开启供应商思考需为思考和最终JSON共同留足输出额度。不得静默提高用户预算。

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

显示需求、阶段依赖/状态、计划原因、预算、报告与交付。选择器标注Coordinator/Worker、阶段与调用序号；执行期间的额外决策标注“玩家消息调度”。历史Reviewer仅供回看，不再新增。

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

## 2026-10-28 角色边界修订

重启 Bot 后使用新设计。最高层不再编写工具参数、能力列表或机器验收表达式，Worker 在变更动作前建立根交付和阶段检查。旧任务中的 semantic_review 检查不会被默许通过；此类任务先停止，再发出剩余任务。个人模型配置和输出预算未自动修改。

报告的程序检查覆盖引用、结构、需求覆盖、世界状态和发送回执，不等同于通用自然语言语义证明。尚需用户自行进行真实模型与服务器验收，本次改动未运行付费测试。

## 执行期间发送新命令

正式 hierarchical 模式允许 Worker 执行期间持续接收获准玩家的带前缀消息，无需等任务结束。Coordinator 判断是回答、澄清、排队、替换、修订、暂停、恢复、结束任务，还是停止当前子任务。接收消息不等于自动取消旧工作。

例如：!agent 你现在在做什么？ / !agent 先暂停 / !agent 恢复刚才的任务 / !agent 停下这个子任务，重新考虑 / !agent 别采集了，先过来。这些是意图示例，具体路由由模型决定，尚待实机验收。

明确的 !agent 停止 始终直接处理，不等模型，并清除未执行消息和排队任务。其他消息调度会增加真实 Coordinator 调用，运行中计入根任务模型调用预算，没有后台轮询模型。入口最多32条待处理消息、8条待执行任务，满时返回 queue_full。内存队列不承诺重启恢复，已启动任务的持久化保留。

替换和修订等待旧任务停止；动作结果不明时保留中断任务，不自动启动替换动作。暂停沿用 interrupted，恢复核对同一 root_task_id、预算和已有效果。结束或停止子任务不记为成功。停止后或任务状态变化后的迟到调度作废。

简单问答可由 Coordinator 根据已有观察直接回复；需要新事实则派发调查。简单行动可单次 delegate，跳过独立的建约定/计划/派发调用；Worker 可将验收附在首次动作中。最高层仍不接触底层动作参数。复杂任务保留阶段规划。legacy 和 CLI --task 行为不变。

### 等待澄清或暂停时补充说明

waiting_input 和 interrupted 也属于未结束任务。自然语言补充经 Coordinator 判断为 correct 后，接续原 root_task_id，不新建或替换根任务；等待中的问题与回答关联，原始命令、补充原文、发起人、已有进展、约束和预算保留。没有正在运行的动作时，不额外发送停止。

显式“回答”也从数据库中的当前问题接续，“纠正”可以修订等待或暂停的任务。普通补充不会放宽既有约束；显式纠正沿用原有修订规则。重启后按同样方式读取待接续任务，不依赖上一次内存中的结果。取消或终结任务不能通过旧回答复活。

此修复只解决接续状态，不增加放置箱子或工作台等接口。
