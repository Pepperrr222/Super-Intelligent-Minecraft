# MC-01 自测：采集10个原木，制作木斧和木镐

使用原版 Java 1.21.1、本项目现有 Coordinator / Worker 和 Mineflayer 执行器。每轮建立独立空背包世界，布置可达橡树；机器人自行决定采集、制作与放置工作台的步骤。

从项目根目录运行，环境需要 Python 3.12+、Node 22+、Java 21+。沿用你的项目配置与 API 密钥文件。

首次准备：

```powershell
python -m pip install -e .
npm ci --prefix executor
python scripts/benchmark_mc01.py prepare
```

运行真实模型任务：

```powershell
python scripts/benchmark_mc01.py run --config config.json --accept-eula
```

这会调用配置中的模型。`--accept-eula` 表示你同意 [Minecraft EULA](https://www.minecraft.net/eula)，测试服仅监听本机。模型配置保持原文件不变，游戏连接由脚本指向独立测试服。也可用 `--orchestration legacy` 比较旧规划器。

## 自动录制操作流程

可选的 `--record` 使用 Fabric 服务端和 [ServerReplay 1.2.10+mc1.21.1](https://modrinth.com/mod/server-replay/version/DsQNSbT9)。只增加录制，不增加游戏内容，也不需要额外玩家客户端挂机。首次安装：

```powershell
python scripts/benchmark_mc01.py prepare --record
```

之后录制真实模型任务：

```powershell
python scripts/benchmark_mc01.py run --config config.json --accept-eula --record
```

录制从场景初始化、清空背包之后开始，覆盖采集、移动、制作、放置和结束检查；任务失败也保存已发生的流程。正常结束显式停止录制，异常退出则由服务端关闭时保存。每轮目录中的 `recording.json` 记录录像路径、开始/停止时间、文件大小和 ReplayMod 元数据；录像位于 `server/recordings/players/<玩家UUID>/*.mcpr`。只有归档包含元数据及非空数据包流才标记 `saved`，这不等于已人工查看或渲染验证。

**`.mcpr` 是游戏回放文件，不能直接当作 MP4 播放。** 在 Minecraft Java 1.21.1 客户端安装 Fabric 和对应版本 [ReplayMod](https://www.replaymod.com/download/)，将 `.mcpr` 复制到该客户端游戏目录的 `replay_recordings/`，从 Replay Viewer 打开，即可观看、跟随 Agent 或调整自由视角。导出 MP4 时在 ReplayMod 中设置镜头/时间关键帧，并按其提示安装 FFmpeg 后渲染。客户端回放、画面和声音以实际渲染为准；当前脚本负责自动采集回放，不自动操控图形客户端导出视频。

同样可用 `smoke --accept-eula --record` 检查从采木到制作两件工具的录制链，它运行固定动作、不调用模型。不开 `--record` 仍启动原版服务端；下载、mod、录像和存档全部留在被 Git 忽略的 `runtime/` 中。

2026-10-29 录制实测：真实 DeepSeek Agent 再次完成 MC-01，约205秒、20次模型调用；生成206秒 `.mcpr`，含1418条完整数据包记录，归档CRC与最后时间戳核对通过。同时通过零模型真实执行器录制、159项Python测试和52项Node测试。尚未通过图形客户端人工回放或导出MP4。脱敏计数见 [录制验收摘要](results/2026-10-29-recording.json)。

零模型执行器联调：

```powershell
python scripts/benchmark_mc01.py smoke --accept-eula
```

smoke 使用明确的脚本动作顺序验证同一执行器，从空背包采集开始，没有预给工具或工作台；它不代表模型规划成绩。

结果默认写入 `runtime/mc01/`：`summary.json`、`results.csv`，以及每轮 `result.json`、`evidence.json`、Agent 轨迹和服务端日志。路径可用 `--output` 指定。每轮最多600秒、30次模型调用，工具预算100；失败记录也保留。

判分只保留三个目标检查：累计采集至少10个原木、真实制作木斧与木镐、最终背包保留两件工具。原木允许消耗；制作与库存从原版服务器计数读取。采集采用挖掘/拾取计数的较小值，适用于这个独立、无其他玩家的自测场景；不实现正式比赛的完整物品来源追踪。死亡判失败，测试设施异常记 invalid。

退出码：0为目标通过，1为目标未完成，2为测试设施异常。具体失败项见 result.json。

实现修复包括：按配方批次同步真实制作结果；新增显式单方块 place 接口；模型只填操作与参数，由程序补齐协议外壳；初始场景与任务目标分开传入；`collected_at_least` 用已确认采集记录累计计数，不因消耗材料误判失败。

2026-10-29 实测：DeepSeek `deepseek-v4.1-flash-1017`、hierarchical、关闭思考、流式输出；约209秒、19次模型调用，累计采集12个原木，制作并保留木斧和木镐，Agent终态completed。起始空背包，没有预给工作台，没有中途人工游戏操作。脱敏计数见 [结果摘要](results/2026-10-29-deepseek-flash.json)。这是一次受控自测成功，不代表多种世界下的稳定成功率。
