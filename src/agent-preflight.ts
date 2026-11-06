import type { BasicOperation } from './schema.js';

/** Contract preflight, not task planning: reject a known unmet hand prerequisite. */
export function handPrerequisite(operations: BasicOperation[], snapshot: any): string | undefined {
  let held: string | undefined = snapshot?.heldItem?.name;
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i]!;
    if (op.type === 'equip' && op.destination === 'hand') held = op.item;
    else if ((op.type === 'place' || op.type === 'place_entity') && held !== op.item) {
      return `第${i + 1}步 ${op.type} 要求先手持 ${op.item}，当前/前序动作只能确认 ${held ?? '未确认'}。请在本批次显式加入 equip(destination=hand)，或重新观察并调整计划；程序不会自动代选动作。`;
    } else if (['unequip', 'select_slot', 'inventory_move', 'toss', 'consume', 'craft', 'craft_output', 'container_transfer', 'place', 'place_entity'].includes(op.type)) held = undefined;
  }
  return undefined;
}

/** Stable facts, excluding query receipts/short-lived references that change on every read. */
export function stableFacts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableFacts);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['ref', 'targetRef', 'itemRef', 'destinationRef', 'offerRef', 'observedAt', 'expiresAt', 'timestamp', 'clientTick', 'observedTick','checkedAt','ageMs'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stableFacts(entry)]));
  return value;
}
