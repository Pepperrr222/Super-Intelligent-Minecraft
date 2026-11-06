import { basicOperationSchema, inputJsonSchema, type BasicOperation } from './schema.js';
import type { z } from 'zod';
import { ActionError } from './executor.js';

export type OperationCard = { type: BasicOperation['type']; available: boolean; reason?: string };
export function operationCatalog(version?: string, capabilities?: readonly string[]): OperationCard[] {
  return basicOperationSchema.options.map(option => {
    const type = option.shape.type.value;
    const capability = type.startsWith('container_') ? 'container' : type.startsWith('furnace_') ? 'furnace'
      : type.startsWith('brewing_') ? 'brewing' : type.startsWith('trade') ? 'trade'
      : type === 'unequip' ? 'equip' : ['look_at', 'look_at_entity'].includes(type) ? 'look'
      : type === 'move_ticks' ? 'move' : type === 'follow' ? 'navigate'
      : type.startsWith('wait') ? 'wait' : type === 'craft_output' ? 'craft' : type;
    const reason = !['1.21.1', '1.21.6'].includes(version ?? '') ? '网关尚未适配此版本'
      : type.startsWith('brewing_') && version !== '1.21.6' ? '酿造槽位仅适配 1.21.6'
      : type === 'dismount' && version === '1.21.6' ? '新输入包分支的下乘语义未验证'
      : capabilities && !capabilities.includes(capability) ? `缺少能力: ${capability}` : undefined;
    return { type, available: reason === undefined, ...(reason ? { reason } : {}) };
  });
}
export function availableOperations(version?: string, capabilities?: readonly string[]): BasicOperation['type'][] {
  return operationCatalog(version, capabilities).filter(card => card.available).map(card => card.type);
}
export function operationSchemas(types: string[]): Array<{ type: string; params: z.core.JSONSchema.BaseSchema }> {
  return types.map(type => {
    const schema = basicOperationSchema.options.find(option => option.shape.type.value === type);
    if (!schema) throw new ActionError('UNKNOWN_OPERATION', `未知操作: ${type}`);
    const params = inputJsonSchema(schema);
    delete params.$schema;
    return { type, params };
  });
}
