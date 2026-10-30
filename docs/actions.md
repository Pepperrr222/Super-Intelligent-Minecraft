# 底层动作目录

当前共有 **44种动作 + 5种查询**。原有19种动作保留；另外包含24种扩展动作及look_at_entity。所有写操作仍通过 `actions.execute()` 使用同一租约。`actions.query()` 是只读入口，不能向世界写数据。

所有坐标都位于 Bot 当前维度。方块坐标必须是整数；视角、实体位置和 look_at 目标允许小数。物品使用版本注册表名称，如 oak_log，不加 minecraft: 前缀。

| type | 参数 | Mineflayer 接口 | 完成条件 / 语义 |
|---|---|---|---|
| move | controls, durationMs | setControlState / clearControlStates | 按键持续指定时间；不保证移动距离 |
| look | yaw, pitch | look | 转向完成；单位为弧度 |
| look_at | position | lookAt | 转向指定坐标 |
| look_at_entity | entityId, part=head | lookAt | 按当前实体位置和部位高度转向一次；不移动、不持续追踪 |
| navigate | position, range=1 | pathfinder.goto / GoalNear | 到达目标范围；默认禁止寻路挖掘和搭方块 |
| follow | entityId, distance=2, durationMs | GoalFollow | 跟随时间段结束；返回实际距离，不保证全程保持距离 |
| dig | position | dig / stopDigging | 单方块客户端状态变化；不包括拾取 |
| place | reference, face | placeBlock | 在参考方块相邻面放置手持物品；检查目标位置变化 |
| equip | item, destination=hand | equip | 装备操作完成 |
| unequip | destination | unequip | 卸下装备操作完成 |
| select_slot | slot | setQuickBarSlot | 选择快捷栏 0–8 槽 |
| use_item | durationMs, offHand=false | activateItem / deactivateItem | 使用指定手中的物品一段时间；效果未确认 |
| consume | 无 | consume | 食用/饮用 Promise 完成；需要先装备 |
| activate_block | position | activateBlock | 对方块右键交互；具体效果需上层判断 |
| activate_entity | entityId | activateEntity | 对实体右键交互；具体效果需上层判断 |
| attack_once | entityId | attack | 发出一次攻击；不保证伤害或击杀 |
| craft | item, repetitions, table? | recipesFor / craft | 按配方执行指定次数，检查产物增量 |
| toss | item, count | toss | 背包减少指定数量；不保证指定玩家收到 |
| container_transfer | position, direction, item, count | openContainer / deposit / withdraw / close | 单次转移后检查背包增量并关窗 |
| wait | durationMs | 可取消计时器 | 等待结束 |

控制键：forward / back / left / right / jump / sprint / sneak；相反方向不能同时指定。
装备位置：hand / off-hand / head / torso / legs / feet。
放置面：up / down / north(-Z) / south(+Z) / east(+X) / west(-X)。
转移方向：deposit（存入）或 withdraw（取出）。普通容器类型以 Mineflayer openContainer 支持范围为准；熔炉、交易、附魔等使用下面的专用动作。

持续时间 1–120000 ms。默认超时为 30000 ms；持续动作默认 durationMs+5000；调用方可在 execute 第二个参数中指定 1–300000 ms 的 timeoutMs。

## 新增动作与精确边界

### 看向玩家或实体：look_at_entity

```json
{"type":"look_at_entity","entityId":42}
{"type":"look_at_entity","entityId":42,"part":"body"}
{"type":"look_at_entity","entityId":42,"part":"legs"}
{"type":"look_at_entity","entityId":42,"part":"feet"}
```

从observe的entities中找到目标id，替换示例42。默认part=head。执行时读取目标最新位置，调用一次lookAt；不启动导航，也不在完成后追踪。返回targetPosition、heightOffset和heightSource便于核对实际瞄准点。

玩家站立时，头部偏移约1.62，身体按身高的60%（约1.08），腿按35%（约0.63），脚为0。通过版本注册表的pose字段定位姿态元数据：潜行采用1.5高度、1.27头部偏移；游泳/爬行/滑翔等低姿态采用0.6高度、0.4头部偏移，身体与腿相应降低。未知或未支持的明确玩家姿态返回UNSUPPORTED_POSE，不继续沿用站立头高；feet仍可用。没有姿态元数据时使用实体当前高度/眼高，缺少玩家高度时回退为站立估计。

这是按高度定义的近似瞄准点，不是模型骨骼定位；尤其横躺姿态和其他生物的头部，不保证精确解剖位置。普通实体优先使用当前高度，缺失时尝试注册表高度；无法确定则返回UNKNOWN_ENTITY_HEIGHT。目标缺失、无效或超出感知范围会失败。已使用1.21.1注册表进行模拟测试，尚未实机验证本动作。

### 其他扩展动作

|type|主要参数|原生调用/机制|成功代表什么|
|---|---|---|---|
|wait_ticks|ticks|physicsTick事件|经过指定客户端物理刻|
|move_ticks|controls, ticks|setControlState + physicsTick|持续输入结束，退出清除按键|
|use_item_ticks|ticks, offHand=false|activateItem / deactivateItem|持用刻数结束，不保证射击命中或格挡|
|wait_until|condition|公开事件 + 局部验证|条件曾被观测为true；未知条件继续等，超时退出|
|place_entity|reference, face|placeEntity|返回新实体观测；可放船/矿车，未包含驾驶|
|activate_entity_at|entityId, offset|activateEntityAt|发出主手定点交互；offset先转成世界坐标|
|craft_output|item, outputCount, table?|recipesFor / craft|新增产量至少达到outputCount，按配方次数向上取整|
|container_inspect|position|openContainer / close|读取当前合法窗口的容器区，随后关窗|
|inventory_move|source, destinationSlot|moveSlotItem|整堆移到另一个空背包槽；校验游标与目标指纹|
|furnace_inspect|position|openFurnace|读取输入、燃料、输出与当前进度；null表示尚未知|
|furnace_put|position, slot, item, count|putInput / putFuel|背包减少对应数量；装料不等于冶炼完成|
|furnace_take|position, slot, expectedItem, minCount=1|update/updateSlot + takeInput/Fuel/Output|等到目标数量后取走整堆并核验增量|
|brewing_inspect|position|openBlock|只在1.21.6、已识别酿造窗口读5个槽；进度/燃料余量unknown|
|brewing_put|position, source, destinationSlot|moveSlotItem|整堆装入指定空槽；不保证药水配方合法或完成|
|brewing_take|position, slot, fingerprint|putAway|取走指定指纹的整堆；组件或数量已变化就拒绝|
|trade_inspect|entityId|openVillager / trades|读最新报价、价格、第二输入、产物组件和报价指纹|
|trade|entityId, offerFingerprint, repetitions|重新开窗匹配报价 → bot.trade|报价仍有效、材料足够、准确产物增量符合预期|
|enchant|position, target, choice, maxLevelCost|openEnchantmentTable / putTargetItem / putLapis / enchant / takeTargetItem|取回具有实际附魔的物品；不保证抽到指定附魔|
|anvil|position, target, second?, rename?, maxLevelCost|openAnvil / combine或rename|观测产物并核对耐久/附魔/名称；现代组件完全保真仍未实测|
|fish_once|无|fish|完成一次原生咬钩/收竿周期，不保证渔获进入背包|
|mount|entityId|mount + 乘坐关系事件|乘坐普通船/竹筏；不证明处于驾驶席|
|vehicle_control|left, forward, ticks|每物理刻moveVehicle|普通船/竹筏水平输入完成；不证明沿路径到达|
|dismount|无|dismount + 关系事件|解除乘坐关系；新player_input分支明确UNSUPPORTED|
|say|message|chat|发送自然语言；过滤基础命令/工具JSON/代码，不证明玩家收到|

`ticks`范围1–2400。客户端物理刻不是服务器权威刻，也不能用固定50ms休眠替代。长动作请显式给出timeoutMs；默认30秒仍有效。非持续动作的等待都受墙钟超时约束，事件监听会在结束/取消时删除。

`source` / `target` / `second` 是 `{slot, fingerprint}`，slot只接受9–44（主背包与快捷栏），fingerprint从snapshot的inventory取得。它包含数量、名称、耐久、附魔、原始NBT和组件；物品改变后应重新观察。打开GUI后会把自己的背包槽转换到窗口inventoryStart，不能把背包slot直接当窗口slot。此精简引用尚不是CoCraftBench规范的session+revision引用。

酿造窗口限定1.21.6：0–2为瓶子、3为材料、4为烈焰粉，布局不符立即停止。当前只提供槽位操作；没有`openBrewingStand`、配方自动推导、药水效果语义解码或自动等待酿造完成。需通过`brewing_inspect`读回真实组件后决定何时取出。

熔炉`slot`在装入时为input/fuel，取出时为input/fuel/output。`minCount`是等待阈值而不是精确取出量，原生take方法取走整堆；已有输出也可能被取走，不能据此证明本次加工来源。燃料可用性/配方选择由技能层负责。

交易不接受固定tradeIndex。先取报价指纹，再重新开窗按完整价格及物品信息查找；价格变化返回STALE_OFFER；同时检查第二输入与剩余次数。只支持普通villager，不外推wandering_trader。

附魔choice为0/1/2，实际消耗等级预算分别至少1/2/3；显示门槛可能为30级。先等待附魔候选，再检查当前等级。铁砧依据已安装Item.anvil估算费用；原生combine可能调整输入顺序；同类物品存在原生NBT匹配歧义时返回AMBIGUOUS_NATIVE_ITEM。失败/取消时投入的物品可能已经移动或消耗，应重新观察。

钓鱼没有原生公共cancel API。取消会尝试收竿，原生Promise未结束前仍占租约；无法结束时需要重建连接。船操作没有自动安全落脚或快乐恶魂飞行能力；1.21.6的dismount分支已发现语义未验证，主动拒绝执行。

## 只读查询

|type|参数|结果|
|---|---|---|
|snapshot|radius=16，最大32|会话ID、客户端刻、位置/速度、血饥饿/氧气/经验、装备、背包指纹、附近实体和原始组件|
|inspect_block|position|已加载方块及properties；未加载或超出32格为unknown|
|find_blocks|names, radius=16, limit=32|在已加载感知区域查找；不意味着全世界不存在其他目标|
|recipes|item, table?|当前材料可用的配方、每次产量和消耗；不自动补齐资源|
|verify|condition|value为true / false / "unknown"，附客户端证据|

condition支持inventory_at_least、block_is（可比较properties）、dimension_is、entity_near、health_at_least。实体消失不等于死亡，未加载方块不等于空气；未解码property为unknown。公开感知半径不是射线遮挡过滤；若评测进一步限制视线，需在适配层增加过滤。

`dimension_is.dimension`使用Mineflayer当前game.dimension原值，例如overworld/the_nether；物品名称也使用短名。这与CoCraftBench对外minecraft命名空间格式不同。

```typescript
const check = actions.query({type:'verify',condition:{kind:'inventory_at_least',item:'iron_ingot',count:16}});
const found = actions.query({type:'find_blocks',names:['oak_log'],radius:16,limit:8});
const result = await actions.execute({type:'use_item_ticks',offHand:true,ticks:40},{timeoutMs:5000});
```

## 保护与验证边界

attack_once拒绝player类别/名称/username目标以及目标4格内可能被挥砍波及的玩家。此保护不等同于完整战斗安全：弓弩、爆炸、环境破坏和保护区域还需要上层策略。say是基础语法过滤，不应把未经处理的模型工具回显交给聊天。

所有动作成功均为本地定义的后置条件成立。客户端E1证据不能证明服务器最终判分、掉落来源、暴击归因、击杀、精确格挡、宝库奖励归属或整题完成。本项目没有读取隐藏fixture或服务器完整世界。

## 示例

```json
{"type":"equip","item":"iron_pickaxe","destination":"hand"}
{"type":"dig","position":{"x":10,"y":64,"z":20}}
{"type":"place","reference":{"x":10,"y":63,"z":20},"face":"up"}
{"type":"craft","item":"oak_planks","repetitions":4}
{"type":"container_transfer","position":{"x":8,"y":64,"z":20},"direction":"deposit","item":"oak_log","count":16}
```

注意：4 次原木→木板配方通常产生 16 个木板，repetitions 是配方次数，不是产物数量。容器、方块操作不会自动导航或自动寻找工具；先调用对应前置动作。交互距离预检为方块 4.5 格、实体 3 格，服务器仍可能因遮挡、权限或版本规则拒绝请求。

## 复用规则

1. 由任务执行器持有同一个 MinecraftActions 实例。
2. 每一步检查 ActionResult.status；失败、取消或超时后不要继续后续步骤。
3. stop 不经过大模型或普通任务队列，直接调用动作控制器。
4. busy 返回给上层调度器处理；底层不隐藏排队、重试或目标选择。
5. “采集16个原木”“把物品交给某玩家”等是组合技能，需要额外验证库存增量、拾取者和交付结果。
