# 模型操作完整目录（生成）

由 pnpm schema 从原生 Schema 派生的操作定义和版本目录生成，不手工编辑。
44 种原生动作各有一个操作入口；可调用不代表前置条件已满足或已实机通过。参数细节查 operations.schema.json 或 operation_schema 查询。
craft 的 count 与 repetitions 必须二选一；? 表示可省略。引用、窗口与证据边界见 basic-operations.md。

|type|参数|1.21.1|1.21.6|
|---|---|---|---|
|move|controls, durationMs|可调用（未实机验收）|可调用（未实机验收）|
|look|yaw, pitch|可调用（未实机验收）|可调用（未实机验收）|
|equip|item, destination|可调用（未实机验收）|可调用（未实机验收）|
|unequip|destination|可调用（未实机验收）|可调用（未实机验收）|
|select_slot|slot|可调用（未实机验收）|可调用（未实机验收）|
|use_item|durationMs, offHand|可调用（未实机验收）|可调用（未实机验收）|
|consume|无|可调用（未实机验收）|可调用（未实机验收）|
|toss|item, count|可调用（未实机验收）|可调用（未实机验收）|
|wait|durationMs|可调用（未实机验收）|可调用（未实机验收）|
|wait_ticks|ticks|可调用（未实机验收）|可调用（未实机验收）|
|move_ticks|controls, ticks|可调用（未实机验收）|可调用（未实机验收）|
|use_item_ticks|ticks, offHand|可调用（未实机验收）|可调用（未实机验收）|
|fish_once|无|可调用（未实机验收）|可调用（未实机验收）|
|vehicle_control|left, forward, ticks|可调用（未实机验收）|可调用（未实机验收）|
|dismount|无|可调用（未实机验收）|新输入包分支的下乘语义未验证|
|say|message|可调用（未实机验收）|可调用（未实机验收）|
|look_at|targetRef|可调用（未实机验收）|可调用（未实机验收）|
|look_at_entity|part, targetRef|可调用（未实机验收）|可调用（未实机验收）|
|navigate|range, targetRef|可调用（未实机验收）|可调用（未实机验收）|
|follow|distance, durationMs, targetRef|可调用（未实机验收）|可调用（未实机验收）|
|dig|targetRef|可调用（未实机验收）|可调用（未实机验收）|
|place|face, targetRef, item|可调用（未实机验收）|可调用（未实机验收）|
|activate_block|targetRef|可调用（未实机验收）|可调用（未实机验收）|
|activate_entity|targetRef|可调用（未实机验收）|可调用（未实机验收）|
|attack_once|targetRef|可调用（未实机验收）|可调用（未实机验收）|
|craft|item, count?, repetitions?, recipeRef, tableRef?|可调用（未实机验收）|可调用（未实机验收）|
|container_transfer|direction, item, count, targetRef|可调用（未实机验收）|可调用（未实机验收）|
|wait_until|condition|可调用（未实机验收）|可调用（未实机验收）|
|place_entity|face, targetRef, item|可调用（未实机验收）|可调用（未实机验收）|
|activate_entity_at|offset, targetRef|可调用（未实机验收）|可调用（未实机验收）|
|craft_output|item, outputCount, recipeRef, tableRef?|可调用（未实机验收）|可调用（未实机验收）|
|container_inspect|targetRef|可调用（未实机验收）|可调用（未实机验收）|
|inventory_move|sourceRef, destinationRef|可调用（未实机验收）|可调用（未实机验收）|
|furnace_inspect|targetRef|可调用（未实机验收）|可调用（未实机验收）|
|furnace_put|slot, item, count, targetRef|可调用（未实机验收）|可调用（未实机验收）|
|furnace_take|slot, expectedItem, minCount, targetRef|可调用（未实机验收）|可调用（未实机验收）|
|brewing_inspect|targetRef|酿造槽位仅适配 1.21.6|可调用（未实机验收）|
|brewing_put|destinationSlot, targetRef, sourceRef|酿造槽位仅适配 1.21.6|可调用（未实机验收）|
|brewing_take|targetRef, itemRef|酿造槽位仅适配 1.21.6|可调用（未实机验收）|
|trade_inspect|targetRef|可调用（未实机验收）|可调用（未实机验收）|
|trade|repetitions, targetRef, offerRef|可调用（未实机验收）|可调用（未实机验收）|
|enchant|choice, maxLevelCost, targetRef, itemRef|可调用（未实机验收）|可调用（未实机验收）|
|anvil|rename?, maxLevelCost, targetRef, itemRef, secondRef?|可调用（未实机验收）|可调用（未实机验收）|
|mount|targetRef|可调用（未实机验收）|可调用（未实机验收）|
