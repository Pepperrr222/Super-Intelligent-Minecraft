/** Query output paths are part of the model API, alongside the input schemas. */
export const QUERY_CONTRACTS = {
  observe_targets: {
    input: 'blockNames/names 仅过滤方块；entityNames 过滤实体名称；itemNames 过滤掉落物内容；entityKinds:["item"] 选所有掉落物。实体过滤字段自动开启实体观测。',
    output: 'data.targets[]: {ref,kind,entityKind?,name,position,observedAt,expiresAt,droppedItem?:{known,name?,count?}}。names 与 blockNames 不是物品过滤器。',
    example: {type:'observe_targets',itemNames:['spruce_log','iron_ingot'],radius:16,limit:16},
  },
  snapshot: {output:'data.entities[] 使用同一 ref 格式，另有 entityKind 与 droppedItem；最多64个最近实体，entitiesTruncated 表示截断。data.inventory[] 是当前库存，含 name/count。'},
  find_blocks: {output:'data.blocks[]: {known,ref,kind,name,position,observedAt,expiresAt,...}。只查方块，不查掉落物。'},
  inspect_block: {output:'已加载范围内 known=true 时返回同一方块 ref；known=false 不提供可操作对象。'},
  verify: {output:'data: {value:true|false|"unknown",evidence,observed}。不会返回 logsTotal 等合计字段。'},
  observe_inventory: {output:'data.items[] 含 itemRef，data.emptySlots[] 含 destinationRef；不能用实体 ref 替代库存引用。'},
  operation_schema: {output:'精确动作参数 schema；params/条件不确定时查询，不能猜测字段。'},
} as const;
