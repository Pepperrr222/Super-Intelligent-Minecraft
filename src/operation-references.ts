import { randomUUID } from 'node:crypto';
import type { Bot } from 'mineflayer';
import { ActionError } from './executor.js';

type Item = NonNullable<Bot['heldItem']>;
type Entry = { kind: 'item' | 'empty' | 'offer' | 'brewing'; dimension: string; version: string; expiresAt: number;
  slot?: number; fingerprint?: string; scope?: string };

/** Opaque per-Bot capabilities. Raw slots, components and fingerprints stay here. */
export class OperationReferences {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly bot: Bot, private readonly fingerprint: (item: Item) => string,
    private readonly now = Date.now) {}
  clear() { this.entries.clear(); }
  private issue(value: Pick<Entry, 'kind' | 'slot' | 'fingerprint' | 'scope'>): string {
    for (const [ref, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(ref);
    while (this.entries.size >= 512) this.entries.delete(this.entries.keys().next().value!);
    const ref = randomUUID();
    this.entries.set(ref, { ...value, dimension: this.bot.game.dimension, version: this.bot.version, expiresAt: this.now() + 30_000 });
    return ref;
  }
  private get(ref: string, kind: Entry['kind']) {
    const entry = this.entries.get(ref);
    if (!entry || entry.kind !== kind) throw new ActionError('UNKNOWN_OPERATION_REF', '物品或报价引用不属于当前 Bot 或种类不匹配');
    if (entry.expiresAt <= this.now()) throw new ActionError('EXPIRED_OPERATION_REF', '物品或报价引用已过期');
    if (entry.version !== this.bot.version || entry.dimension !== this.bot.game.dimension) throw new ActionError('STALE_OPERATION_REF', '引用的维度或版本已变化');
    return entry;
  }
  private itemAt(slot: number) {
    const window = this.bot.currentWindow;
    return window ? window.slots[window.inventoryStart + slot - 9] : this.bot.inventory.slots[slot];
  }
  observe(offset: number, limit: number) {
    const items = [], emptySlots = [];
    for (let slot = 9 + offset; slot < Math.min(45, 9 + offset + limit); slot++) {
      const item = this.itemAt(slot);
      if (item) items.push({ itemRef: this.issue({ kind: 'item', slot, fingerprint: this.fingerprint(item) }),
        name: item.name, count: item.count, durabilityUsed: item.durabilityUsed ?? null,
        enchants: item.enchants?.map(enchant => ({ name: enchant.name, lvl: enchant.lvl })) ?? [] });
      else emptySlots.push({ destinationRef: this.issue({ kind: 'empty', slot }) });
    }
    return { items, emptySlots, nextOffset: offset + limit < 36 ? offset + limit : null, ttlMs: 30_000 };
  }
  item(ref: string) {
    const entry = this.get(ref, 'item'), item = this.itemAt(entry.slot!);
    if (!item || this.fingerprint(item) !== entry.fingerprint) throw new ActionError('STALE_ITEM', '引用物品已移动、消耗或属性改变');
    return { slot: entry.slot!, fingerprint: entry.fingerprint! };
  }
  empty(ref: string) {
    const entry = this.get(ref, 'empty');
    if (this.itemAt(entry.slot!)) throw new ActionError('DESTINATION_OCCUPIED', '引用的空槽已经被占用');
    return entry.slot!;
  }
  quote(kind: 'offer' | 'brewing', scope: string, fingerprint: string, slot?: number) {
    return this.issue({ kind, scope, fingerprint, slot });
  }
  resolveQuote(kind: 'offer' | 'brewing', scope: string, ref: string) {
    const entry = this.get(ref, kind);
    if (entry.scope !== scope) throw new ActionError('REFERENCE_SCOPE_MISMATCH', '引用不属于此目标，请重新检查');
    return { fingerprint: entry.fingerprint!, slot: entry.slot! };
  }
}
