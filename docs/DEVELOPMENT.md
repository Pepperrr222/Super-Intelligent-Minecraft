# 运行与开发

## 安装

仓库采用可编辑安装，从源码目录运行；Node 执行器与 Python 一起保存在同一 checkout。

```bash
python -m venv .venv
# 激活虚拟环境后执行
python -m pip install -e .
npm ci --prefix executor
python scripts/dev.py check
python scripts/dev.py test
python scripts/dev.py demo
```

Windows 激活命令为 `.venv\Scripts\Activate.ps1`，Linux 为 `source .venv/bin/activate`。未激活时也可直接使用虚拟环境 Python 的绝对路径运行 `scripts/dev.py`。

若普通终端无法找到 Node，可在本机配置 JSON 顶层增加 `"node_executable": "C:/实际安装目录/node.exe"`。带目录的相对路径以配置文件目录为基准；也支持 `SIM_NODE` 环境变量。优先级为显式运行器参数、本机配置、SIM_NODE、PATH 中的 node，开发检查与测试同样支持本机配置。不要提交个人安装路径。

## 配置

复制根目录 config.example.json 为 config.json。修改 agent.owner 为游戏内用户名，model.name 为实际账户可用的模型 ID。API 需要支持 `/chat/completions` 与 JSON object 输出。模型、价格和调用结果必须以自己的实际账号验证，模板不预填未经验证的型号。

小组共同测试时可设置 `"owner": "*"`，接受所有玩家的 `!agent ` 指令，不需要列出三人的用户名。机器人自己的消息会被忽略。任务共享且不排队，任意获准玩家可用 `!agent 停止`、`!agent 纠正 ...` 和 `!agent 回答 ...` 控制当前任务。修改后重启 Agent 生效，无需重启游戏服务器。

创建 `.secrets/model.key`，只写密钥。key_file 和 runtime_dir 的相对路径以配置文件目录为基准。不要把真实密钥写进 JSON、命令行、日志或 Git。

learning.mode 为 B0 或 B1，默认 B0。正式对照实验要冻结数据库副本，不能把后运行的组偷偷混入更多经验。当前运行器每轮结束会写入 SQLite，因此冻结测试需要给每次试验提供独立的基准数据库副本；批量恢复工具待实现。

world_id 是人工管理的世界标签，加上实际维度形成观察作用域，不是存档 UUID。切换存档要换标签，修改配方时更新 ruleset_id。

## 本地原版服务器

先安装 Java 21，阅读 Minecraft EULA，然后按自己的意愿执行：

```bash
python scripts/setup_lab.py --accept-eula
```

脚本下载并校验官方 1.21.1 服务端，保存在 runtime/server。它创建只监听 127.0.0.1 的离线认证实验服，不接触个人存档。

启动服务器：Windows 使用 `./scripts/server.ps1`，Linux 使用 `bash scripts/server.sh`。可用 SIM_JAVA 指定 Java 路径。机器人和玩家连接配置中的端口，默认 25575。

另开终端运行 `python scripts/dev.py run`。也可使用根目录 run.ps1 / run.sh。CLI 退出码：0 表示任务完成，1 表示任务未完成，2 为配置或参数问题，3 为连接等 Agent 错误。

无需密钥的试用：`sim-agent --planner rules --config config.json`。规则模式要求明确坐标和物品数量，示例见 README。云模型模式默认启用，模型 ID 和密钥需要自行配置，不会自动调用未授权的付费服务。

## 真实动作验收

scripts/fixture_commands.txt 是管理员场景夹具，只对隔离测试世界操作。建立场景后执行 `python scripts/smoke_executor.py`。夹具和 Agent 的操作入口分离，Agent 没有服务器控制台、生成物品或传送工具。

真实验收日志输出 runtime/executor-smoke.json，即使失败也应保留。不要把该动作级验收当成自然语言任务级验收。

完整自动化验收：先停止手动测试服，再运行 `python scripts/live_acceptance.py --java <Java21路径>`。该脚本仅启动自己的 127.0.0.1:25575 服务，不占用已有服务器，也不杀死其他进程；依次执行动作、中文规则任务和双玩家聊天验收，最后正常关闭。

自动验收会重建隔离场景。失败、通过记录与服务端日志按运行编号归档到 runtime/acceptance/。代码在运行中变化时，该轮不会被视为稳定验收。通过后用 `python scripts/export_acceptance.py` 导出公开摘要和源码 SHA-256，原始日志留在本地。

## 日志

- runtime/tasks.jsonl：完整任务结果、步骤、状态和验证证据。
- runtime/requests.jsonl：跨进程请求及响应。
- runtime/usage.jsonl：实际模型用量。
- runtime/memory.sqlite3：轨迹、候选技能与复验关联。
- runtime/demo/：明确标记 MOCK_ONLY 的离线演示。
- runtime/task-evidence/、runtime/chat-evidence/：真实任务和聊天的完整日志。
- runtime/acceptance/：按运行编号归档的真实验收证据。

`sim-evaluate runtime/tasks.jsonl` 汇总一组同环境同版本试验，不混入 demo。缺失验证或验证为 false 的 completed 不计成功；取消、失败和超时仍保留分母。

## 故障定位

先运行 check，再按连接、单动作、目标验证、高层规划的顺序定位。Windows 不认识 python 时使用 py 或虚拟环境解释器；Node 不存在则安装 Node 22+。模型不可用时确认 API 地址、账户模型 ID 和 key_file。遇到卡住或取消，检查状态与部分效果后再重试，避免重复转移物品。
