# 零模型单动作调试

这是独立诊断入口，不是第三套规划系统。复用已有 ExecutionController、Mineflayer 动作、轮询、取消和程序目标验证。不会构造 Coordinator、Worker、LLMPlanner、RulePlanner 或模型客户端，不读取密钥或检索经验。

## 启动

先关闭原 Bot，再在仓库根目录执行：

```powershell
.\.venv\Scripts\python.exe scripts/dev.py run --config config.json --action-debug --dashboard
```

也可以使用不含 model 对象的本地配置，例如 config.debug.local.json。Minecraft、agent、runtime_dir 等原有必填配置仍需保留。配置中的 orchestration 模式和学习选项由显式调试入口覆盖为无模型/B0行为，不修改配置文件。不要将 --action-debug 和 --orchestration 或 --goal-json 混用。

日志写入原 runtime_dir 下的 action-debug/ 子目录。没有经验库、模型归档或自动任务续接。面板显示动作和验证轨迹，不会显示模型思考。

## 第一版语法

```text
!agent collect oak_log 4
!agent collect minecraft:spruce_log 2
!agent 采集4个橡木原木
!agent 收集2根云杉原木
!agent goto 10 -60 5
!agent 去坐标 10 -60 5
!agent 停止
```

采集数量使用阿拉伯数字1..64，要求明确树种。支持橡木、白桦、云杉、丛林、金合欢、深色橡木、红树、樱花原木。暂不接受石头等掉落映射不同的方块；“原木”不自动猜树种。goto 必须指定三个坐标，固定验证距离2格内。

解析完整输入，不截取前半句。“采集4个橡木原木然后制作木镐”“collect oak_log 4 不要移动”等复合请求或额外约束会被拒绝，不执行其中一部分，也不回退模型。craft、follow、取放、冶炼和放置方块不在第一步范围。

终端单动作示例：

```powershell
.\.venv\Scripts\python.exe scripts/dev.py run --config config.json --action-debug --task "goto 10 -60 5"
```

## 执行与验证

程序生成动作与目标，记录观察和库存基线，提交一次高层技能，等待终态并重新观察。单次预算为 agent.task_timeout_seconds 与60秒中的较小值。技能内部已有的搜索、寻路、装备、挖掘、拾取仍由原执行器完成，本轮不更改其算法或硬编码参数。

- collect.count 仍为方块数。原木任务同时要求成功动作证据、足量 mined_count 和相对基线新增目标原木。旧库存、无关掉落或不足数量不能报完成。
- goto 用最新位置验证，提交成功回执不等于到达。
- 失败或停止保留实际状态和库存变化；变化量无法确认时不编造数字。
- 原有玩家权限与前缀生效；调试模式忙碌时拒绝另一个动作，停止直接处理，不调用模型。
- 结果不明确时锁住调试入口，不自动重放或开始下一个动作。先人工核对，停止旧执行器并重新连接后再测。

这是工程诊断入口，不会自动补材料、制造工具、探索、搭路、放置设施或分解复杂目标。共用技能的候选选择、工具选择、掉落确认和取消收敛问题仍属于第二步，尚未因本入口自动解决。

## 验证范围

tests/test_action_debug.py 使用本地替身验证语法完整性、零模型调用、单技能调用、库存增量、挖掘证据、位置验证、权限、忙状态和停止后的未知效果保护。真实 Minecraft 中的寻路、工具装备、挖掘与拾取效果仍由用户测试，不能把本地测试通过当成实机通过。
