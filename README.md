# Super Intelligent Minecraft

自然语言处理课程项目：通过中文指令操控 Minecraft，在执行反馈中积累经验，逐步研究整合包规则变化下的技能更新。

当前阶段先完成 **Minecraft Java 1.21.1 原版 Agent**。Python 负责规划、状态和结果验证，Node.js + Mineflayer 负责游戏动作。模型参数固定，学习发生在外部经验库。

## 项目结构

```text
src/sim_agent/
  app/                 CLI、配置和离线演示，组装各层
  domain/              TaskSpec、复合目标、约束、状态与参数校验
  planning/            模型适配器、单步规划、提示词
  execution/           任务循环、动作轮询、取消、玩家指令入口
  adapters/            Mineflayer JSONL 客户端、离线 Mock
  memory/              SQLite 轨迹、经验检索、技能复验与迁移
  observability/       任务、协议、模型用量日志
  evaluation/          基于验证记录的完成率与代价统计
executor/
  server.js            Node 子进程入口，stdout 仅用于 JSONL
  lib/actions/         移动、跟随、采集、合成、取放、熔炼
  lib/                 生命周期、观察、游戏适配和协议校验
  test/                执行器测试
benchmarks/            任务目录和分阶段实验清单
docs/
  design/              原始 DOCX 和开题 PPT
scripts/               跨平台开发入口、隔离测试服和真实动作验收
tests/                 Python 离线与跨层测试
.github/workflows/     Windows / Linux CI
```

## 快速开始

要求 Python 3.12+、Node.js 22+。运行独立游戏测试服还需要 Java 21。

在仓库根目录执行，Windows 可将 `python` 换成 `py -3.12`：

```bash
python -m venv .venv
# Windows 激活：.venv\Scripts\Activate.ps1
# Linux/macOS 激活：source .venv/bin/activate
python -m pip install -e .
npm ci --prefix executor
python scripts/dev.py check
```

先跑无需 Minecraft 和 API 密钥的离线流程：

```bash
python scripts/dev.py demo
python scripts/dev.py test
sim-evaluate runtime/demo/tasks.jsonl
```

离线演示使用明确标记的 Mock 和固定脚本，演示取料、合成、交付、验证及存储的连通性。它不测试模型理解或真实游戏能力。

## 连接原版服务器

1. 复制 `config.example.json` 为 `config.json`，修改服务器、玩家名、模型 ID 和 API 地址。
2. 将密钥写入 `.secrets/model.key`，配置只保存路径。相对路径以配置文件所在目录为基准。
3. 连接已启动的本地原版服务器，或按 [运行说明](docs/DEVELOPMENT.md) 创建隔离测试服。
4. 执行 `python scripts/dev.py run` 或 `sim-agent --config config.json`。

暂未配置 API 时可用 `sim-agent --config config.json --planner rules`。这是有限中文语法基线，支持明确坐标的移动、取料合成交付、物品存放和有限时长跟随；歧义请求会要求澄清。默认 `--planner llm` 使用云模型，不会静默降级成规则模式。

当前执行器面向本机离线认证实验服。`agent.owner` 填游戏用户名时仅接受该玩家；填 `"*"` 时接受所有玩家，适合小组共同测试。所有玩家仍需使用前缀，机器人忽略自己的聊天。一次只执行一个任务，忙碌时拒绝新任务；所有获准玩家都能停止、纠正当前任务或回答澄清问题：

```text
!agent 去坐标 1 -60 2 附近
!agent 采集附近橡木，让背包新增4个橡木木板
!agent 把背包中的2个橡木木板放入坐标4 -60 0的箱子
!agent 停止
!agent 纠正 改放入坐标10 -60 0的箱子
!agent 回答 来源坐标0 -60 -4，目标坐标8 -60 0
```

终端单次任务：

```bash
sim-agent --config config.json --task "去坐标 1 -60 2 附近"
```

停止绕过模型，直接取消执行。显式“纠正”先停止旧任务，再把真实进度与新要求交给下一版本；“回答”接续上一次澄清问题。普通新任务在忙碌时仍被拒绝。游戏内进度消息限流，防止原版服将机器人当作刷屏者踢出。只有程序复核目标成立，任务才记为完成。

## 查看实时规划

启动时加 `--dashboard`，浏览器打开终端显示的本机地址（默认 http://127.0.0.1:8765）：

```bash
python scripts/dev.py run --config config.json --dashboard
```

面板按时间显示目标、模型公开的决策说明、下一步提案、程序拒绝或放行、动作反馈和独立完成验证，并可切换最近任务。它读取 `runtime_dir/trace.jsonl`，不额外调用模型，也不展示模型内部隐藏推理。升级后需重启 Agent 才能记录逐步规划。

也可单独运行 `python scripts/dashboard.py --config config.json`，在 Agent 退出后继续查看记录；用 `--runtime-dir runtime/demo` 查看明确标记的离线演示。详见 [规划面板](docs/DASHBOARD.md)。

规则模式的可复现交付示例：

```text
!agent 从坐标0 -60 -4的箱子取2个橡木原木，做成8块橡木木板，放入坐标8 -60 0的箱子，不砍树
```

系统在动作前捕获两个箱子的数量基线，完成时检查来源减少2、目标新增8、背包原木和木板净变化为0。目标箱原有木板不会冒充本次交付。

## 自我学习的实施阶段

| 版本 | 定义 | 当前状态 |
| --- | --- | --- |
| B0 | 实时观察、规划、反馈修正，无跨任务检索 | 可运行基线 |
| B1 | 检索同世界、同规则版本、同目标类型的历史执行证据 | 已接入，效果待真实实验 |
| B2 | 参数化技能复用 | 存储与复验接口已实现，提取与自动执行待接入 |
| B3 | 依赖指纹与局部失效更新 | 存储层接口已实现，规则发现、变化监测和执行接入待完成 |

默认 `learning.mode` 为 `B0`，可设置 `B1`。两者都保存轨迹，B0 不读取历史经验。B2/B3 不能作为运行配置启用。`ruleset_id` 当前是人工维护的版本标签，改变配方或存档时必须同步更新。

候选技能要关联两次不同重置场景、不同任务 ID 的成功复验，且结果经程序验证，才允许晋升。调用前仍要检查当前条件。自动技能执行尚未接入。

## 文档与验证边界

- [系统架构](docs/ARCHITECTURE.md)：职责、数据流和原设计对应关系。
- [动作协议](docs/PROTOCOL.md)：JSONL 契约与数量语义。
- [云模型配置](docs/MODELS.md)：DeepSeek/SiliconFlow 参数、密钥路径和真实验收入口。
- [运行与开发](docs/DEVELOPMENT.md)：安装、测试和隔离世界。
- [能力与验收](docs/VALIDATION.md)：实现、离线测试与真实验收的区别。
- [后续路线](docs/ROADMAP.md)：原版、NLP、学习和整合包适配。
- [实验约定](benchmarks/README.md)：B0/B1 先导实验与后续消融。

已在官方原版 1.21.1 隔离服完成23项动作、复合任务和真实玩家聊天检查，摘要见 [原版验收证据](benchmarks/results/vanilla-2026-10-28.json)。另以 DeepSeek 与 SiliconFlow 实际云模型分别执行移动、约束交付、保留材料合成和歧义澄清，使用相同执行层与独立世界检查，见 [云模型记录](benchmarks/results/cloud-2026-10-28.json)。开发中失败的运行也保留在记录中。

这些是受控工程验收，没有测量经验学习提升或通用生存能力。当前后端只覆盖原版动作集合，整合包兼容需要单独验证。

依赖参考：[Mineflayer API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md)、[Pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)。原始设计保存在 [docs/design](docs/design)。
