# Minecraft 基础版 Agent

Python 决策层 + Mineflayer 执行层。目标是先做一个能真实执行和复核的原版 Agent，使用现有 DeepSeek API，不训练模型。

这是独立项目；之前 Jarvis / AIM / MineMind 的试用代码与整合包保留在各自目录。设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，进程协议见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。

## 本机运行

环境：Node 22、Python 3.12+、Minecraft Java 1.21.1。已准备 `.venv` 和 `executor/node_modules`。

先启动隔离服务器：

```bash
cd /home/pcn789/minecraft-basic-agent
./scripts/server.sh
```

另开终端启动 Agent：

```bash
cd /home/pcn789/minecraft-basic-agent
./run.sh
```

在 Prism 中启动 **AI Basic · 原版 Agent 试用**，多人游戏连接 `127.0.0.1:25575`。若新实例没出现在列表，Prism 主窗口按 F5。此实例仅原版，没有 NeoForge / Forge / 内容模组。

当前授权玩家为 `Doctor_Pepper`，机器人为 `BasicAgent`。聊天示例：

```
!agent 采集附近的橡木，让背包比现在新增4个橡木木板
!agent 去坐标 1 -60 2 附近
!agent 把背包中的2个橡木木板放进坐标4 -60 0的箱子
!agent 检查坐标4 -60 0的箱子，从里面取1个粗铁和1个煤，用坐标6 -60 0的熔炉炼成铁锭并取出
!agent 停止
```

具体任务能否完成取决于当前材料、地形和槽位状态。接受新任务会锁定一个可检查目标；执行中再次发任务会明确提示忙碌。停止指令直接执行，不需要等待模型。

也可在终端执行一次任务，结束后机器人退出：

```bash
./run.sh --task '采集橡木并合成木板，让背包新增4个橡木木板'
```

## 配置与数据

实际配置为 `config.json`，公开模板为 `config.example.json`。密钥仍保存在本机现有文件中，配置只记录密钥文件路径。模型仅在执行任务时调用，空闲时不轮询模型。

- `minecraft`：服务器、版本、机器人名、世界标签。
- `agent`：指令拥有者、前缀、步数和时间上限。
- `model`：兼容 API 地址、模型名和密钥文件路径。
- `runtime`：任务、协议和模型用量日志，及完全独立的服务端测试世界。

更换存档时修改 `minecraft.world_id`，防止旧任务状态被用于新世界。当前标签不等于游戏存档 UUID。离线认证服务器只监听本机，适合这台电脑上的实验；接远程或公开服务器时应另配正常认证和访问控制。

## 验收与复现

验收结果和已知限制见 [docs/VALIDATION.md](docs/VALIDATION.md)。真实游戏测试、离线测试、模型自主任务会分开记录。

```bash
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests -v
cd executor
npm test
```

`scripts/smoke_executor.py` 是真实服务器动作验收，需要先在隔离服务器控制台建立 `scripts/fixture_commands.txt` 的夹具。夹具只提供场地、原料、箱子和熔炉；不生成测试目标产物。不能对玩家正式世界执行该夹具。Agent 本身没有控制台、传送或生成物品接口。

初次安装时使用 `python3 -m venv .venv`、`cd executor && npm ci`。初次下载服务器使用 `python scripts/setup_lab.py`，脚本校验 Mojang 下载清单中的 SHA-1，并为本地实验服接受 Minecraft EULA。现有服务端配置不会被重复覆盖。

## 当前边界

支持移动、有限时长跟随、方块搜索与采集、配方合成、标准箱子/木桶存取和标准熔炉流程。寻路不自动挖路或铺路。不支持内容模组、任意 GUI、任意代码生成、完整从零生存或自动战斗。第一阶段保存任务证据；长期技能检索与经验学习尚未实现。

依赖来源：[Mineflayer](https://github.com/PrismarineJS/mineflayer)、[Pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)。高低层分工参考 [Hi Robot](https://www.pi.website/research/hirobot) 的层次化思路，未复现其模型与训练。
