import type { Bot } from 'mineflayer';

/** Uses the installed prismarine-entity decoder; unknown metadata never becomes a guessed item. */
export function droppedItem(entity: Bot['entity']): { known: boolean; name?: string; count?: number } | undefined {
  if (!['item', 'Item', 'item_stack'].includes(entity.name ?? '')) return undefined;
  try {
    const item = (entity as typeof entity & { getDroppedItem?: () => { name: string; count: number } | null }).getDroppedItem?.();
    return item && typeof item.name === 'string' && Number.isInteger(item.count) && item.count > 0
      ? { known: true, name: item.name, count: item.count } : { known: false };
  } catch { return { known: false }; }
}
