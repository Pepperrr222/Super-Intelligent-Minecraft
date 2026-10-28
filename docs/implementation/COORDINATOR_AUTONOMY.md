# Coordinator 自主规划修订（2026-10-28）

本文件是用户确认后的当前设计，替代旧手册中“独立 LLM Reviewer”和“Coordinator 编写底层验收/动作能力列表”的部分。原版执行范围、取消、预算、持久化、B0 和 Mineflayer 规则继续有效。修改前检查点：`6635927`（本地 Git）。

## 职责与数据边界

- Coordinator 接收原始命令、玩家修订、业务能力说明、事实与阶段进展。理解任务、选择方法、调查条件、分解阶段、派发、重规划、报告可以往返进行，不设固定思考顺序，也不强迫先选有限世界目标。
- Coordinator 不接收执行器工具表、动作参数、动作日志协议或机器验收表达式。`agents/business_context.py` 把查询和动作证据投影成保留证据 ID 的事实视图；事实不等于行动授权。
- Worker 接收当前阶段、完整需求与约束、实际工具能力及证据。负责局部调查、动作选择和把自然语言完成标准编译成程序检查。不能修改根需求或用户约束。
- 不存在独立模型 Reviewer；只有 Coordinator 和 Worker 两种模型调用。参数、权限、状态、预算、停止、基线和结果验证仍由程序负责。

## 业务提议

模型消息信封仍为 `coordinator-proposal.v1` / `worker-proposal.v1`，角色交互采用 `business.v2` 字段约定；Node JSONL 协议未改变。

根交付：`{id, description, requirement_ids, completion_criteria:[自然语言结果]}`。

阶段：`{id,title,objective,requirement_ids,dependencies,mode,completion_criteria,input_evidence_ids?,expected_outputs?,budget?}`。

`mode` 为 `investigate` 或 `execute`。程序给调查阶段只读权限，执行阶段的工具仍逐次检查全局约束。调查需要移动或开容器时，应采用 execute 阶段并明确目标。业务层不能提交 `allowed_capabilities` 或 `acceptance_checks`。

`request_information` 只指定 `{question,evidence_refs}`，不指定查询接口。Worker 可以在未知条件查清后返回缺失材料、能力或交付方式。Coordinator 决定继续调查、调整计划、澄清或报告无法完成。

不要把“给我”擅自加强为“必须本次新制作”，也不能把“给玩家”弱化成“Bot 背包里有”或“聊天说完成”。当前执行器没有直接向玩家交付物品和验证玩家拾取的能力；应明确容器交付等可行方式，不能借用容器动作假装实现玩家交付。

## Worker 编译验收

Worker 新提议 `prepare_verification`：

```json
{"deliverables":[{"id":"d1","acceptance_checks":["使用既有 CHECK 对象，示例占位"]}],"stage_checks":["使用既有 CHECK 对象，示例占位"]}
```

首次编译必须覆盖全部根交付，不接受遗漏或重复 ID。根检查编译后冻结；之后 `deliverables` 必须为 `[]`。阶段检查也只能在尚未建立时编译。允许先查询事实，变更动作必须等根交付和当前阶段均有有效验收后才执行。需要的容器基线在动作前捕获；既有取消、保留库存、明确容器绑定和未知动作不重放规则继续执行。

支持实际状态谓词、查询/成功动作证据、报告引用和回复回执。没有办法表达可靠检查时 Worker 应返回 blocked，不能退化成一条“已完成”的文字。旧 `semantic_review` 检查不会自动通过；需要结束旧任务并重新下达，建立新的检查。

调查结果允许是“未找到”“条件不足”，不要求在调查阶段完成后续制作。阶段执行成功和根任务完成分别验证；计划改写不计为世界进展。

## 报告与可观察性

面板展示 Coordinator / Worker 各自真实返回的思考和决策、自然语言阶段完成标准、Worker 编译事件、动作反馈和程序验证。历史 Reviewer 记录仍可回看，标注为已移除。

报告检查覆盖结构、需求 ID、证据引用存在性、允许证据类型、实际世界检查和发送回执。取消独立 Reviewer 后，不再声称程序已完成通用自然语言事实的语义审查；叙述是否忠实由 Coordinator 负责，不能因引用了证据就宣称任意文字得到机器证明。复杂语义无法可靠验证时应保留限制，而不是虚报完成。

## 运行与验证

重启 Bot 使用新代码；仍须显式启用 `--orchestration hierarchical`。本次不修改个人配置、不提高输出预算，不开展云模型或真实服务器测试。旧低层契约格式只用于既有内部回归夹具；正式 AgentTeam 使用业务边界，不能提交该格式。

离线演示：`python -B -m sim_agent.app.hierarchical_demo --output runtime/coordinator-autonomy-demo`（需 PYTHONPATH=src）。它运行真实调度、编译、控制和验证代码，但模型与游戏均为脚本/Mock，不能作为自然语言实机验收。

人工复验重点：原话是否保留；最高层是否用业务阶段而不是工具参数；缺少交付方式是否澄清；Worker 是否从调查推进到动作；取消是否立即响应；失败后是否保留真实进展。暂停和修订的旧任务如含旧语义检查，先停止再重新发出剩余任务，避免混用旧验收。

## 持续消息与短流程修订

- execution/service.py 过滤身份和前缀，orchestration/player_inbox.py 提供独立事件消息通道。Worker 执行期间，Coordinator 可处理新消息。
- 调度使用 coordinator-proposal.v1，purpose=player_message，kind 为 reply / clarify / queue / replace / correct / pause / resume / cancel_stage / end。queue、replace、correct 保留接收时的原文和发起人，不使用模型改写的命令。
- reply 引用已有事实，不修改任务；只有一个根任务控制身体。replace/correct 等待停稳，未知动作阻止自动替换。pause 保留同根进度；cancel_stage 只停止子任务，保留效果并交回根决策。
- 停止、断线和关闭使调度失效；版本、任务对象与子任务 attempt 检查防止迟到结果作用于新任务。消息队列有界，目前不持久化。
- Coordinator 新增 answer {report}：已有事实上的问答只需一次高层调用，程序检查报告引用和回执；不能在已有动作任务上借此跳过世界验收。
- Coordinator 新增 delegate {contract_draft?,stage}：建立业务意图并立即派发单阶段 Worker。
- Worker query/act 可附 verification:{deliverables,stage_checks}，同次调用准备后执行。相同验收重复提交幂等确认，实际改写仍拒绝；成功动作或编译后清除旧修复上下文。
- 不增加寻路、搭建或玩家拾取验证等底层能力，不可达环境仍需真实反馈和玩家协助。
