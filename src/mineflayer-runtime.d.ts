import type { Bot } from 'mineflayer';
// Present in Mineflayer 4.39.0 lib/plugins/entities.js; omitted from its public declaration.
declare module 'mineflayer' {
  interface Bot { vehicle?: Bot['entity'] | null }
}
