# Super-Intelligent-Minecraft

自然语言处理课程项目：通过中文指令控制 Minecraft Agent。

当前先完善 **Minecraft Java 1.21.1 原版 Bot**。Python 负责两层决策、任务状态和验证，Node.js + Mineflayer 负责游戏动作。自学习和整合包兼容后置。

## 当前状态

当前设计：**Coordinator → Worker → 执行控制与验证 → Mineflayer**。Coordinator 理解需求、调查条件、分解和派发业务阶段；Worker 选择底层工具并编译验收标准。独立 LLM Reviewer 已移除。

新架构仍需显式启用，缺省配置继续使用 legacy。最新本地149项 Python、48项 Node测试及离线演示通过，采集可靠性已有本地修订，但复杂任务与新拾取策略仍需真实游戏复验，不代表完整生存能力验收通过。

- [当前进度](docs/implementation/PROGRESS.md)
- [已知问题](docs/implementation/KNOWN_ISSUES.md)
- [文档导航](docs/README.md)

## 安装与启动

需要 Python 3.12+、Node.js 22+；独立测试服另需 Java 21。在仓库根目录执行：

```bash
python -m venv .venv
# Windows 激活：.venv/Scripts/Activate.ps1
# Linux/macOS 激活：source .venv/bin/activate
python -m pip install -e .
npm ci --prefix executor
python scripts/dev.py check
```

复制 config.example.json 为 config.json，填写服务器、玩家和模型信息。密钥放在 .secrets/ 中，配置只引用密钥文件路径；详见 [模型配置](docs/MODELS.md)。私人配置不提交 Git。

Windows 启动当前两层模式：

```powershell
.\.venv\Scripts\python.exe scripts/dev.py run --config config.json --orchestration hierarchical --dashboard
```

激活虚拟环境后，也可使用跨平台写法：

```bash
python scripts/dev.py run --config config.json --orchestration hierarchical --dashboard
```

两层模式要求 learning.mode=B0。浏览器地址以终端显示为准，默认 http://127.0.0.1:8765。面板展示各角色真实返回的思考与决策、阶段、执行反馈和验证，本身不额外调用模型。修改代码或配置后重启 Bot。

## 游戏内使用

agent.owner 设为游戏用户名时只接受该玩家；设为 "*" 时接受所有玩家，适合小组共同测试。同一时刻只有一个任务控制 Bot，但执行期间可以继续发送问题和新命令，由 Coordinator 决定回答、排队、替换或暂停。详见 [持续消息说明](docs/implementation/RUNNING.md)。

```text
!agent 描述你所处的环境
!agent 请你做一把石镐，不用给我，直接放在你的背包里就可以
!agent 停止
!agent 纠正 改放入坐标10 -60 0的箱子
!agent 回答 目标坐标10 -60 0
```

示例用于人工验收，复杂制作任务可能触发 [已知问题](docs/implementation/KNOWN_ISSUES.md)，不代表已通过。

停止绕过模型；纠正和回答沿用任务的真实进度。当前没有直接向玩家交付并验证拾取的接口，容器交付需明确目标。运行、恢复和预算见 [两层运行说明](docs/implementation/RUNNING.md)。

## 本地验证

需要单独排查游戏动作时，使用 [零模型单动作调试](docs/ACTION_DEBUG.md)：

```powershell
.\.venv\Scripts\python.exe scripts/dev.py run --config config.json --action-debug --dashboard
```

游戏内输入 `!agent collect oak_log 4`、`!agent goto 10 -60 5` 或 `!agent 停止`。该入口不创建模型客户端，可不填写 model 配置，不支持复杂任务或自动补料；采集第一版限定明确树种的原木。

以下命令不调用云模型：

```bash
python scripts/dev.py test
python scripts/dev.py demo
```

第一项运行 Python 与 Node 测试；第二项为既有离线 Mock 基线演示。新版两层脚本演示入口及环境要求见 [架构修订](docs/implementation/COORDINATOR_AUTONOMY.md)。脚本与 Mock 演示不等于真实模型或 Minecraft 验收。

真实游戏、云模型测试入口见 [脚本导航](scripts/README.md)，按需手动运行。

## 目录职责

```text
src/sim_agent/
  app/                 CLI、配置、面板和离线演示
  agents/              Coordinator / Worker 提示词与高层事实视图
  orchestration/       两层生命周期、阶段调度和预算
  domain/              需求契约、目标、约束和纯校验
  capabilities/        原版执行能力清单
  execution/           共用控制器、legacy 循环和玩家指令入口
  verification/        程序验收和报告引用检查
  interaction/         回复分段与提交回执
  persistence/         当前任务快照、动作日志和恢复记录
  adapters/            Mineflayer 客户端和 Mock
  planning/            模型接口、流式接收及 legacy 规划器
  observability/       事件、模型调用和用量记录
  memory/              既有经验存储与检索；新版仅 B0
  evaluation/          验证记录统计
executor/              Mineflayer 执行器、动作及 Node 测试
tests/                 Python 离线测试
scripts/               开发、测试服和验收入口
docs/                  当前设计、运行说明、交接和原始题目
benchmarks/            实验计划与既有验收摘要
runtime/               本地日志、数据库、测试服与存档，不提交
.secrets/              本地密钥，不提交
.github/workflows/     Windows / Linux CI
```

原始题目与开题 PPT 在 [docs/design](docs/design)。已有 legacy 受控验收摘要在 [benchmarks/results](benchmarks/results)，不能替代当前架构的完整验收。学习和整合包研究计划见 [后续路线](docs/ROADMAP.md)。
