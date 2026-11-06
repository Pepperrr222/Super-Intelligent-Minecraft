# SIM · 可复用 Minecraft 底层动作

本轮验证：编译与全部 **334 项模拟测试通过**；动作/查询及阶段 JSON Schema、提示词审阅包已重新导出。未进行真实模型或服务器复测。

**2026-11-05 sim-v2-9：** 当前 V2 已收敛为一个决策模型：理解消息 → 查询/动作批次或可选阶段 → 读取真实结果 → 自动继续/纠错/完成。取消主控与执行模型之间的转述和独立验收调用。快照、方块查询、目标查询提供统一 ref；掉落物使用 itemNames/entityKinds 查询。最新结构见 [大脑架构](docs/brain-architecture.md)，完整新提示词见 [审阅包](docs/brain-prompts-review.md)。下方旧版本条目保留为历史记录；本版实机复测尚未进行。

**2026-11-05 sim-v2-8：** 已按用户要求删除方案与回复的模型复核。当前大脑只有理解、主控、执行、最终验收四个职责；聊天一次调用，方案通过程序校验后直接执行。328 项模拟测试通过，实机结果待重启验证；本地启用配置已同步。见 [当前架构](docs/brain-architecture.md) 和 [完整提示词](docs/brain-prompts-review.md)。

**2026-11-05 大脑入口统一：** 默认启动切换到 V2；普通消息直接进入推理模型大脑，停止/暂停/取消/继续保留本地控制入口。新增 `AgentBrain` 集中六种模型职责与输出校验，执行模型默认也使用主推理模型。328 项模拟测试通过，本轮没有真实模型或服务器验证。先看 [当前大脑架构](docs/brain-architecture.md) 与 [完整提示词审阅包](docs/brain-prompts-review.md)；按用户要求，审阅启用前 V2 不发送模型请求。下方日期较早的条目是历史阶段记录。

**2026-11-03 持续阶段执行：** sim-v2-7 新增通用阶段方案解释器，支持结果绑定、分支、遍历、有界重复、事件等待与约束中断，正常步骤间不再逐批调用模型。320 项自动测试通过；真实 DeepSeek 生成的两份方案在模拟世界分别连续完成 11/6 个动作，各 1 次模型调用。未真实服务器验收。见 [阶段执行](docs/stage-execution.md)。

**2026-11-03 新任务修复：** sim-v2-6 调整独立指令与追加任务的语义，暂停任务收到明确行动补充时重新分配有限额度；修复省略 requestReview 导致重复复核，加入模型复核前的失效目标检查。307 项模拟测试通过，真实模型完整任务未验收；旧存档中的错误目标不自动改写。

**2026-11-03 上下文修复：** V2 增加按实际字节预算压缩工作上下文，修复已有磨损工具被制作查询误判为缺失。提示词 sim-v2-5，304 项模拟测试通过；需正常重启 V2，完整实机任务仍待验证。

**2026-11-03 继续任务修复：** 修复玩家重复指令被识别为 amend 后沿用零额度、立即暂停的问题。明确“继续”或补充耗尽任务会开启新的有限执行轮次，保留进度/待对账操作；重启和普通聊天不补额度。提示词 sim-v2-4，299 项模拟测试通过，需正常重启 V2 加载。

**2026-11-03 配方与资源记忆：** V2 新增合并配方/共享材料检查、短配方编号、持久容器记录及同阶段连续执行。45 动作、14 查询；295 项模拟测试通过，尚未实机验收。正常重启 V2 生效；详见 [配方与容器记忆](docs/resource-knowledge.md)。

**2026-11-03 修复：** V2 已修复放置前置条件遗漏的拦截、对账混合证据被拒绝，以及执行预算耗尽连带阻断聊天的问题；281 项测试通过。正常重启 V2 生效，修复后实机验证待完成。见 [运行说明](docs/agent-v2.md)。

**Agent V2 首版（2026-11-02）：** 持续目标、主控/执行双角色、基本动作组合、自然语言证据验收与任务持久恢复已接通实验模式，275 项自动测试通过。双击 `启动AI伙伴V2.cmd` 使用，旧入口仍为 legacy。尚未真实模型/服务器验收，长期经验记忆与旧技能生产代码清理待完成。见 [V2 运行说明](docs/agent-v2.md) 和 [设计](docs/agent-v2-design.md)。当前 45 动作、12 查询；下文保留此前阶段记录。

**运行排障 GUI（2026-11-02）：** 已接入本地只读诊断台，按玩家指令查看模型返回、程序拒绝、任务、动作和验收。双击 `启动诊断台.cmd`，或 `pnpm diagnostics`；新版伙伴会记录实际链路。需正常重启旧伙伴才能开始采集。当前256项测试通过，界面不代表目标管理问题已经修复。详见 [运行诊断界面](docs/diagnostics.md)。

**最新进展（2026-11-01）：** 44 种原生动作现已全部提供 LLM 操作入口；1.21.1 可调用 41 种，三种酿造槽位接口需 1.21.6。模型可查看全部动作的可用状态并按需查询参数，物品和报价使用可复查的短期引用。当前为 45 个底层动作（含网关）、11 种查询，251 项自动测试通过。实机验收及 P3 持续目标规划仍未完成。见 [完整操作目录](docs/operation-catalog.md) 与 [接口边界](docs/basic-operations.md)。

首批七个动态技能（导航、找资源、拾取、采集、制作、存入、交付）的契约、失败条件和验证状态见 [skills.md](docs/skills.md)；原木采集细节见 [gather-wood.md](docs/gather-wood.md)。两者均只通过模拟测试，尚需真实服务器逐项验证。

**当前阶段：玩家命令→交互→brain→调度器→控制器→底层动作的最小闭环已经打通；新的有界决策循环（观察→选技能/计划→程序校验→执行→验收反馈→有界跟进）已实现并通过模拟测试；DeepSeek LLM 已接入旧版规划/回复，真实 DeepSeek 意图路由冒烟通过；首批七个动态技能已实现并通过模拟测试，底层动作已有手动单 Bot 服务器冒烟，但尚未完成技能逐项实机验收、新决策提示词的真实模型调用、持久化恢复、多 Bot 并发和稳定实机任务验证。** 完整技能库、长程规划与记忆尚未实现。

入口：[当前进度](PROJECT_STATUS.md) · [文档导航](docs/README.md) · [动作目录](docs/actions.md) · [开发路线](docs/roadmap.md)

2026-11-01 首轮基础改造已实现：理论配方查询、递归材料需求、模型同轮知识查询与按指定配方制作；共 235 项模拟测试通过。接口与限制见 [配方知识与精确制作](docs/recipe-knowledge.md)。当前共 44 个动作、8 种查询；持续目标规划、持久化恢复和本轮实机验收仍未完成。

## 项目目录

```text
SIM/
├─ README.md              项目入口、启动与调用
├─ PROJECT_STATUS.md      当前进度与验证边界
├─ AGENTS.md              开发约定
├─ src/                   动作实现、执行控制、调度、交互、brain、LLM、观测与Schema
├─ examples/              控制台调试、熔炼组合、伙伴端到端示例
├─ test/                  执行器、调度器、控制器、交互、LLM与端到端模拟测试
├─ scripts/               Schema导出、benchmark静态分析
├─ docs/                  设计说明、动作目录、生成映射与路线
├─ .reference/            固定版本的外部参考源码（忽略）
├─ dist/                  编译产物（忽略）
└─ node_modules/          安装依赖（忽略）
```

源码与参考资料已分开；生成文件在docs/README.md中标注维护方式。`.auth/`、`.env`、`.secrets/`、日志与本地包缓存也已忽略。当前工作区已有 Git 历史，新改造尚未提交。

## 已有能力

基于 Mineflayer 4.39.0 与 mineflayer-pathfinder 2.4.5 的 TypeScript 动作库。供后续伙伴大脑、任务调度器、技能库或 Node-RED 适配器调用。当前包含 **45 种动作 + 11 种只读查询**，提供参数校验、互斥执行、取消和超时；另提供 `TaskScheduler` + `ActionController` + `InteractionService` + `CompanionBrain` 的最小上层骨架（内存队列/依赖/重试策略/单一租约/聊天网关/小模型意图/模型规划）。新增look_at_entity支持按部位看向玩家，默认头部；项目目标版本为1.21.1，既有其他接口的版本限制仍以动作目录为准。

此前已分析 CoCraftBench 的 42 个契约和全部 100 题，并补充熔炉、酿造槽位、交易、附魔、铁砧、钓鱼、物理刻控制、观测与条件等待。先读 [CoCraftBench 分析](docs/cocraftbench-analysis.md)，再查 [完整动作目录](docs/actions.md) 和 [100题对照表](docs/cocraftbench-tasks.md)。当前44个SIM动作是更细的实现单元，不与基准42个工具一一对应，也不兼容其完整请求/结果外壳。

配置推理模型时，非安全消息进入统一决策循环：构建脱敏上下文、按需查询配方知识、调用模型、程序校验技能/计划，通过后交给调度器；未配置时保留小模型优先的旧路由。两种模式都保留 stop/pause/resume/cancel 本地快路径；决策循环还能在玩家明确要求时返回 `control.cancel` 结束当前任务，或用 `replaceCurrent` 先停止旧任务再提交新目标。模型不可用、超时或输出无效时要求澄清。持久记忆、持久任务账本和 Node-RED 尚未接入。现有 256 项自动测试使用模拟 Bot、假端口和假 LLM，以及本地版本配方数据检查查询/执行/调度/交互语义；此前决策提示词有少量实机现场观察，本轮知识查询和制作对账尚无真实模型或服务器验收。

## 运行与检查

需要 Node.js 22 及以上版本，建议使用本机已有的 Node.js 24。

```powershell
cd D:\Projects\SIM-remote-work
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm schema
pnpm analyze:benchmark # 需要 .reference/CoCraftBench 源码快照
```

连接已部署的 Java 服务器：

```powershell
$env:MC_HOST = '127.0.0.1'
$env:MC_PORT = '25565'
$env:MC_USERNAME = '你的机器人账号'
$env:MC_AUTH = 'microsoft'
$env:MC_VERSION = '1.21.1' # 本项目目标版本；必须与实际服务器一致
pnpm start
```

默认 Microsoft 登录，需要自行完成账号认证；登录资料保存在被忽略的 `.auth/`。只有你自己的测试服务器本来就使用离线认证时，才设置 `MC_AUTH=offline`。没有修改服务器认证配置。可通过 `MC_VERSION` 显式指定兼容版本，不设置时交给 Mineflayer 自动检测。

启动伙伴端到端模式（游戏聊天里说“过来”“跟着我”“背包里有什么”“停”）：

Windows 可双击 `启动AI伙伴.cmd`，无需在终端配置 pnpm。首次填写服务器地址、机器人账号、认证方式和允许控制的玩家名；配置保存在被忽略的 `.companion.local.json`，之后可编辑该文件修改。Microsoft 认证时按窗口提示完成登录；仅在自己的服务器已使用离线认证时填写 `offline`。启动窗口保持打开，按 Ctrl+C 停止。项目依赖需事先安装；密钥继续使用现有 `.secrets/` 或环境变量。

```powershell
$env:MC_OWNERS = '你的玩家名'
pnpm companion
```

`MC_OWNERS` 为空时是开发模式，所有玩家都被当作 owner；正式服务器必须配置。`pnpm companion` 使用 [examples/companion.ts](<D:\Projects\SIM\examples\companion.ts>)，接线链路是：聊天 → InteractionService → CompanionBrain → TaskScheduler → ActionController → MinecraftActions。

### LLM 配置

启动时会自动查找 `.secrets/deepseek.key` 或 `.secrets/siliconflow.key`，也可以用环境变量：

```powershell
$env:LLM_PROVIDER = 'deepseek'        # 或 siliconflow
$env:LLM_MODEL = 'deepseek-chat'      # 可选，默认按 provider
$env:LLM_FAST_MODEL = '你的快速模型'  # 仅显式 legacy 模式使用；默认 V2 不使用小模型分类
$env:LLM_PLANNER_MODEL = '你的规划模型' # 可选，需由同一 provider 提供
$env:LLM_BASE_URL = 'https://api.deepseek.com' # 可选
$env:LLM_TIMEOUT_MS = '15000'
```

也支持 `DEEPSEEK_API_KEY`、`SILICONFLOW_API_KEY` 或通用的 `LLM_API_KEY`。默认优先 DeepSeek，其次 SiliconFlow。`.secrets/` 已加入 `.gitignore`；key 不会被打印到日志，也不要粘贴到聊天/文档里。

如果使用 SiliconFlow 的小模型（例如 `Qwen/Qwen2.5-7B-Instruct`），要同时设置 `LLM_PROVIDER=siliconflow` 和 `LLM_FAST_MODEL=...`；只设置模型名时仍按默认 provider，可能把模型名发给 DeepSeek。

出生后在控制台输入一行 JSON，例如：

```json
{"type":"move","controls":["forward"],"durationMs":500}
```

输入 `observe` 查看位置、实体编号和背包；`stop` 取消当前动作；`quit` 退出。控制台在动作执行时仍可接收 stop。

看向玩家：从observe中取得玩家实体id，把下面的42替换成实际编号。part可选head（默认）、body、legs、feet；不会移动或持续追踪。

```json
{"type":"look_at_entity","entityId":42,"part":"head"}
```

只读查询使用单独入口，可在动作执行时读取：

```json
{"query":{"type":"find_blocks","names":["oak_log"],"radius":16,"limit":10}}
{"query":{"type":"inspect_block","position":{"x":10,"y":64,"z":20}}}
{"query":{"type":"verify","condition":{"kind":"inventory_at_least","item":"iron_ingot","count":16}}}
```

## 程序调用

```typescript
import { MinecraftActions } from './src/index.js';

const actions = new MinecraftActions(bot); // 每个 bot 只创建一个控制器
const result = await actions.execute({
  type: 'navigate', position: { x: 10, y: 64, z: 20 }, range: 1
}, { timeoutMs: 20_000 });

if (result.status !== 'succeeded') {
  console.log(result.status, result.error);
}
actions.stop(); // 可由独立的玩家停止事件随时调用
const state = actions.observe(); // 只读，不占用动作控制权
const check = actions.query({ type: 'verify', condition: {
  kind: 'inventory_at_least', item: 'iron_ingot', count: 16
}});
```

调用方也可提供 `AbortSignal`。退出时调用 `actions.dispose()` 清理监听器。发生永久断线后，应建立新 Bot 和新控制器；不要直接绕过动作库调用另一个寻路或背包插件争抢同一机器人的控制权。

## 任务调度与步骤控制

`TaskScheduler` 管顺序、依赖、重试和取消；`ActionController` 管当前步骤的前置/后置检查、单一租约和回执。控制器不排队、不自动重试、不选目标。

```typescript
import { MinecraftActions, ActionController, TaskScheduler } from './src/index.js';

const actions = new MinecraftActions(bot);
const controller = new ActionController(actions);
const scheduler = new TaskScheduler(controller);

scheduler.submit({
  id: 'go-to-chest',
  priority: 10,
  steps: [{
    id: 'approach',
    actions: [{ type: 'navigate', position: { x: 10, y: 64, z: 20 }, range: 2 }],
  }],
});

await scheduler.runUntilIdle();
console.log(scheduler.get('go-to-chest')?.state);
```

只有 `idempotent: true` 的步骤才允许配置自动重试；`partial`、`blocked`、`busy` 不会被控制器偷偷重放。当前账本是内存实现，进程重启后任务不会自动恢复。

## 玩家交互

`InteractionService` 负责聊天入口、权限、限流、意图路由、澄清和回复。它不直接执行动作；stop 走快路径，任务/查询/聊天交给 `BrainPort`，动作交给可选的 `ActionResolverPort`。内置技能/计划不再需要二次确认；交互层仍保留兼容外部端口的确认分支。

```typescript
import { CompanionRuntime } from './src/index.js';

const runtime = new CompanionRuntime(bot, {
  owners: ['你的玩家名'],
});

runtime.start();
```

`CompanionRuntime` 会自动组装 `MinecraftActions → ActionController → TaskScheduler → CompanionBrain → InteractionService`。聊天回复走 `MineflayerChatTransport` 的直连 `bot.chat`，**不占用动作租约**；长任务执行时也能回话。

配置推理模型（`plannerLlm` 或 `llm`）时，非安全消息走统一决策循环：`CompanionBrain.decide()` 构建 `BrainContextV1`（脱敏观测、技能卡、会话/任务/反馈摘要），模型返回 `reply`/`clarify`/`skill`/`plan`/`control`；`DecisionValidator` 再校验技能可用性、参数 schema、坐标/容器/工作台/玩家名 grounding、任务占用、重复失败和 owner 权限。技能和计划通过校验后自动开始，没有“回复确认”这一步。`currentTask` 只包含仍在执行的四种状态；玩家没有明确要求时，模型不能取消或替换。明确要求结束时，模型可返回 `control.cancel`；明确要求改做别的事时，可在新技能/计划上设置 `replaceCurrent`，由程序先停止旧任务。`stop`/`pause`/`resume`/`cancel` 仍在模型之前本地处理；停止和取消会中止在途决策、清理待澄清状态并丢弃迟到结果。

未配置推理模型时保留小模型优先路由：`stop`/`pause`/`resume`/`cancel` 是本地快路径，其余消息交给限时结构化小模型，输出 `skill`/`query`/`plan`/`reply`/`confirm`/`reject`/`clarify`。模型不可用、超时或输出无效时直接澄清，不再回退关键词规则；内置路径已不产生待确认任务，交互层仅为外部端口保留 confirm 分支。`navigate_to` 的坐标必须出现在玩家消息中，否则要求澄清；技能参数仍经 schema 校验。背包查询由模型返回 `filter`（food/tools/blocks/armor/weapons/all），服务端只按物品元数据过滤，不解析玩家消息里的分类关键词。复杂目标先回执，再异步规划；计划只能引用已注册技能，并在入队前校验参数、动作、依赖和预算，校验通过后直接执行。模型不能直接提交底层动作。停止会取消规划和调度中的任务，丢弃迟到的规划结果。

任务结束后，`buildRunFeedback` 把控制器/技能结果整理成 `RunFeedbackV1`；只有“完成 + 所有步骤 ok + 最后一步已验证 + 至少一项背包/容器/位置变化”才标记 `verified`。程序先发送确定性摘要，模型只允许在 `run_finished` 回合补充一次下一步建议：默认单目标、计划最多 4 步/120 秒、最多 2 次重规划、最多 6 个决策回合，完成或取消后不自动开启新任务，同一调用失败两次后阻止原样重试。设计细节和当前缺口见 [决策循环设计记录](docs/prompt-review-draft.md)。

技能层已有通用注册/运行器，首批七个动态技能均已登记到 `SkillCatalog`：`navigate_to` 复查最终位置；`find_resource` 只返回候选；`collect_drops` 接近掉落物并核对背包增量；`gather_wood` 按观察→接近→复查→挖掘→拾取→背包增量验收执行；`craft_item` 检查材料/工作台并核对产物；`store_items` 核对容器与背包两侧变化；`deliver_to_player` 接近玩家并丢出物品，但明确标记接收不可验证。小模型意图路由和规划器可直接选择这些技能；`navigate_to`/`store_items` 的坐标、`craft_item.table` 的坐标和 `deliver_to_player.player` 必须出现在玩家消息或计划目标中，否则不会执行。建造、熔炼、耕种、战斗、自动重规划、技能间结果传递、世界版本缓存和真实服务器延迟验证仍未实现；不要把模拟测试当作实机验收。技能契约、失败码和验证状态见 [docs/skills.md](docs/skills.md)。

## 统一结果

每个结果包含 `id / type / status / startedAt / finishedAt / data / error`。

- `succeeded`：完成该底层动作定义的条件；不代表上层任务完成。
- `invalid`：参数不合法，未开始执行。
- `not_ready`：未出生、死亡、断线或控制器已释放。
- `busy`：另一个动作尚未释放控制权；本次请求没有加入队列。
- `cancelled` / `timed_out`：请求已取消或超时，可能已经产生部分效果。
- `failed`：执行失败，查看 `error.code` 和 `error.message`。

取消不是回滚。挖掘、移动、使用物品和跟随有停止操作；已发出的攻击、放置、合成或背包请求可能仍会完成。取消会立即返回，但不能立即中断的原生 Promise 未结束前 `busy` 保持 true。若底层一直不结束，应断开旧 Bot 并建立新连接，不应强制解锁继续发送动作。

`data.evidence` 标明依据：客户端状态、背包增量、Mineflayer Promise 完成或仅请求发出。攻击不会声称已造成伤害，丢出物品不会声称玩家已收到；挖掘不会声称已收集掉落物。客户端方块变化也不等同于服务器最终确认。

## 文件入口

- `src/schema.ts`：45 种动作、11 种查询、44 种模型操作及白名单条件的运行时校验。
- `src/targets.ts`、`src/basic-operations.ts`：短期观测引用、执行时复查与模型操作能力目录。
- `src/recipes.ts`、`src/requirements.ts`：可替换配方知识契约、本地数据源、指定配方评估与有界递归需求。
- `src/crafting.ts`：两个制作动作共用的配方选择、整批预检、背包对账和失败证据。
- `src/executor.ts`：单动作控制权、取消、超时及错误归一化。
- `src/actions.ts`：Mineflayer 适配、前置检查和结果证据。
- `src/extensions.ts`：物理刻、工作站、交易、钓鱼、载具和聊天动作。
- `src/observation.ts`：感知范围、物品组件/指纹、局部三值验证。
- `src/control.ts`：可取消的事件等待及 physicsTick 控制。
- `src/task.ts`：Task/Step/Controller 契约与端口类型。
- `src/controller.ts`：单步骤执行、前置/后置检查、取消、busy 与证据回执。
- `src/scheduler.ts`：任务队列、依赖、优先级、重试策略、暂停/取消与内存账本。
- `src/interaction.ts`：聊天入口、权限/限流、小模型意图、仅安全控制本地快路径、会话状态、澄清与路由。
- `src/chat.ts`：Mineflayer 聊天网关；收发不经过动作租约。
- `src/brain.ts`：技能编译、限时对话、异步计划，以及统一决策入口 `decide()`。
- `src/brain-contract.ts`：`BrainContextV1`、`BrainDecision`、`RunFeedbackV1` 与 `DecisionPort` 类型。
- `src/brain-context.ts`：脱敏观测摘要、技能卡、反馈截断和字节预算。
- `src/brain-decision.ts`：统一决策提示词、严格 JSON 解析、程序校验、拒绝码、自动开始与模型发起的取消/替换。
- `src/brain-feedback.ts`：从控制器结果构建可核验的 `RunFeedbackV1` 和确定性玩家文本。
- `src/goals.ts`：单活动目标、预算、重规划上限与重复失败阻断。
- `src/skills.ts`：确定性技能目录、参数与动作校验。
- `src/skill-runtime.ts`：动态技能契约、注册表、运行器及观察/动作上下文。
- `src/builtin-skills.ts`：首批七个内置动态技能及其参数 schema、默认注册表。
- `src/planner.ts`：技能计划的依赖、预算与条件校验。
- `src/llm.ts`：OpenAI 兼容客户端和 `.secrets` 加载；不记录 key。
- `src/runtime.ts`：单 Bot 组合根，串起 actions/controller/scheduler/brain/interaction。
- `src/index.ts`：上层模块的统一导入入口。
- `docs/actions.md`：动作目录及参数含义。
- `docs/prompt-review-draft.md`：决策循环的输入字段、提示词、校验与反馈设计记录（已实现，保留审阅文本）。
- `docs/actions.schema.json`：可供工具调用或界面使用的 JSON Schema，由 pnpm schema 生成。
- `docs/queries.schema.json`：只读查询的 JSON Schema。
- `docs/cocraftbench-coverage.json`：42个契约、100题的可用积木及缺口，不表示通过率。
- `examples/console.ts`：手动连接与调试入口。
- `examples/smelt.ts`：装料→加燃料→等待取出的组合示例，首个失败即停止。
- `examples/companion.ts`：玩家聊天→交互→brain→调度→控制器→动作的端到端入口。
- `test/`：执行器、模拟 Bot、调度器、控制器、交互与端到端行为检查。

`gather_wood` 是首个完整技能切片：它把 `find_blocks`、`inspect_block`、`navigate`、`dig` 和掉落物拾取、库存验收组合在一个可取消的循环里。目标规划、自动重试和技能间组合仍由上层承担；合成配方来自当前 Bot 的游戏版本注册表。

参考：
- https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md
- https://github.com/PrismarineJS/mineflayer-pathfinder
- 实现时核对了已安装版本的类型定义、digging.js、inventory.js 与 pathfinder movements.js。
- 本轮额外核对 furnace.js、villager.js、enchantment_table.js、anvil.js、fishing.js、entities.js、prismarine-item 与 prismarine-windows 的1.21.6数据。
- CoCraftBench源码提交：be208787b6d1831c8897e42a505319c04db5923b；本地只读参考位于 `.reference/CoCraftBench/`，不作为运行时依赖。
