# SIM · 可复用 Minecraft 底层动作

**当前阶段：玩家命令→交互→brain→调度器→控制器→底层动作的最小闭环已经打通；DeepSeek LLM 已接入 brain 的规划/回复并做过冒烟测试；尚未服务器实测、持久化恢复或 LLM 意图分类验证。** 完整技能库、长程规划与记忆尚未实现。

入口：[当前进度](PROJECT_STATUS.md) · [文档导航](docs/README.md) · [动作目录](docs/actions.md) · [开发路线](docs/roadmap.md)

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

源码与参考资料已分开；生成文件在docs/README.md中标注维护方式。`.auth/`、`.env`、`.secrets/`、日志与本地包缓存也已忽略。当前SIM目录尚未建立独立Git历史。

## 已有能力

基于 Mineflayer 4.39.0 与 mineflayer-pathfinder 2.4.5 的 TypeScript 动作库。供后续伙伴大脑、任务调度器、技能库或 Node-RED 适配器调用。当前包含 **44 种动作 + 5 种只读查询**，提供参数校验、互斥执行、取消和超时；另提供 `TaskScheduler` + `ActionController` + `InteractionService` + `CompanionBrain` 的最小上层骨架（内存队列/依赖/重试策略/单一租约/聊天网关/规则意图/规则计划/可选LLM规划）。新增look_at_entity支持按部位看向玩家，默认头部；项目目标版本为1.21.1，既有其他接口的版本限制仍以动作目录为准。

此前已分析 CoCraftBench 的 42 个契约和全部 100 题，并补充熔炉、酿造槽位、交易、附魔、铁砧、钓鱼、物理刻控制、观测与条件等待。先读 [CoCraftBench 分析](docs/cocraftbench-analysis.md)，再查 [完整动作目录](docs/actions.md) 和 [100题对照表](docs/cocraftbench-tasks.md)。当前44个SIM动作是更细的实现单元，不与基准42个工具一一对应，也不兼容其完整请求/结果外壳。

这是新的底层实现起点。意图分类仍是规则版，brain 已可选接入 LLM 规划/回复；持久记忆、持久任务账本和 Node-RED 尚未接入。现有自动测试使用模拟 Bot、假端口和假 LLM 检查执行/调度/交互语义，并有一条从玩家消息到动作执行的端到端模拟测试。

## 运行与检查

需要 Node.js 22 及以上版本，建议使用本机已有的 Node.js 24。

```powershell
cd D:\Projects\SIM
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
$env:LLM_BASE_URL = 'https://api.deepseek.com' # 可选
$env:LLM_TIMEOUT_MS = '15000'
```

也支持 `DEEPSEEK_API_KEY`、`SILICONFLOW_API_KEY` 或通用的 `LLM_API_KEY`。默认优先 DeepSeek，其次 SiliconFlow。`.secrets/` 已加入 `.gitignore`；key 不会被打印到日志，也不要粘贴到聊天/文档里。

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

`InteractionService` 负责聊天入口、权限、限流、意图路由、澄清/确认和回复。它不直接执行动作；stop 走快路径，任务/查询/聊天交给 `BrainPort`，动作交给可选的 `ActionResolverPort`。

```typescript
import { CompanionRuntime } from './src/index.js';

const runtime = new CompanionRuntime(bot, {
  owners: ['你的玩家名'],
});

runtime.start();
```

`CompanionRuntime` 会自动组装 `MinecraftActions → ActionController → TaskScheduler → CompanionBrain → InteractionService`。聊天回复走 `MineflayerChatTransport` 的直连 `bot.chat`，**不占用动作租约**；长任务执行时也能回话。

`CompanionBrain` 目前是规则版：支持“过来”“跟着我”“背包里有什么”/位置查询和简单聊天；复杂任务会返回澄清，不会伪造计划。

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

- `src/schema.ts`：44 种动作、5 种查询及白名单条件的运行时校验。
- `src/executor.ts`：单动作控制权、取消、超时及错误归一化。
- `src/actions.ts`：Mineflayer 适配、前置检查和结果证据。
- `src/extensions.ts`：物理刻、工作站、交易、钓鱼、载具和聊天动作。
- `src/observation.ts`：感知范围、物品组件/指纹、局部三值验证。
- `src/control.ts`：可取消的事件等待及 physicsTick 控制。
- `src/task.ts`：Task/Step/Controller 契约与端口类型。
- `src/controller.ts`：单步骤执行、前置/后置检查、取消、busy 与证据回执。
- `src/scheduler.ts`：任务队列、依赖、优先级、重试策略、暂停/取消与内存账本。
- `src/interaction.ts`：聊天入口、权限/限流、规则意图、会话状态、澄清/确认与路由。
- `src/chat.ts`：Mineflayer 聊天网关；收发不经过动作租约。
- `src/brain.ts`：Brain v0，规则版“过来/跟着我/背包查询/位置查询”+ 可选 LLM 规划/回复。
- `src/llm.ts`：OpenAI 兼容客户端和 `.secrets` 加载；不记录 key。
- `src/runtime.ts`：单 Bot 组合根，串起 actions/controller/scheduler/brain/interaction。
- `src/index.ts`：上层模块的统一导入入口。
- `docs/actions.md`：动作目录及参数含义。
- `docs/actions.schema.json`：可供工具调用或界面使用的 JSON Schema，由 pnpm schema 生成。
- `docs/queries.schema.json`：只读查询的 JSON Schema。
- `docs/cocraftbench-coverage.json`：42个契约、100题的可用积木及缺口，不表示通过率。
- `examples/console.ts`：手动连接与调试入口。
- `examples/smelt.ts`：装料→加燃料→等待取出的组合示例，首个失败即停止。
- `examples/companion.ts`：玩家聊天→交互→brain→调度→控制器→动作的端到端入口。
- `test/`：执行器、模拟 Bot、调度器、控制器、交互与端到端行为检查。

下一层可组合 `navigate → equip → dig → observe`，实现采集技能；目标查找、任务规划、自动重试和掉落物拾取由技能层承担。合成配方来自当前 Bot 的游戏版本注册表。

参考：
- https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md
- https://github.com/PrismarineJS/mineflayer-pathfinder
- 实现时核对了已安装版本的类型定义、digging.js、inventory.js 与 pathfinder movements.js。
- 本轮额外核对 furnace.js、villager.js、enchantment_table.js、anvil.js、fishing.js、entities.js、prismarine-item 与 prismarine-windows 的1.21.6数据。
- CoCraftBench源码提交：be208787b6d1831c8897e42a505319c04db5923b；本地只读参考位于 `.reference/CoCraftBench/`，不作为运行时依赖。
