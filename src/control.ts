import type { Context } from './executor.js';
type EventSource = { on(event: string, listener: (...args: any[]) => void): unknown; removeListener(event: string, listener: (...args: any[]) => void): unknown };

/** Event-driven predicate check with abort cleanup, including events fired synchronously by start. */
export async function until(c: Context, source: EventSource, events: string[], predicate: () => boolean, start?: () => void): Promise<void> {
  c.check();
  await new Promise<void>((resolve,reject) => {
    const cleanup = () => { for (const event of events) source.removeListener(event,check); c.signal.removeEventListener('abort',abort); };
    const check = () => { try { c.check(); if (predicate()) { cleanup(); resolve(); } } catch (e) { cleanup(); reject(e); } };
    const abort = () => { cleanup(); reject(c.signal.reason); };
    for (const event of events) source.on(event,check);
    c.signal.addEventListener('abort',abort,{once:true});
    try { start?.(); check(); } catch (e) { cleanup(); reject(e); }
  });
}

export async function physicsTicks(c: Context, source: EventSource, ticks: number) {
  let elapsed = 0;
  const increment = () => { elapsed++; };
  source.on('physicsTick',increment);
  try { await until(c,source,['physicsTick'],()=>elapsed>=ticks); }
  finally { source.removeListener('physicsTick',increment); }
  return elapsed;
}
