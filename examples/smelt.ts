import type { MinecraftActions } from '../src/actions.js';
import { actionSchema, type ActionResult } from '../src/schema.js';

/** Caller supplies known compatible ingredients, fuel, an accessible furnace and sufficient space.
 * No auto-gather, blind retries or task-success claims. Stops on the first failed/partial step. */
export async function smeltBatch(actions: MinecraftActions, request: {
  position: {x:number;y:number;z:number}; input: string; output: string; count: number;
  fuel: string; fuelCount: number; timeoutMs?: number; signal?: AbortSignal;
}): Promise<ActionResult[]> {
  const sequence: unknown[] = [
    {type:'furnace_put',position:request.position,slot:'input',item:request.input,count:request.count},
    {type:'furnace_put',position:request.position,slot:'fuel',item:request.fuel,count:request.fuelCount},
    {type:'furnace_take',position:request.position,slot:'output',expectedItem:request.output,minCount:request.count}
  ];
  const results: ActionResult[] = [];
  if (!Number.isInteger(request.count) || request.count<1 || request.count>64) throw new RangeError('示例单批数量必须在1–64');
  if (request.timeoutMs!==undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs<1 || request.timeoutMs>300_000)) throw new RangeError('timeoutMs 必须在1–300000');
  sequence.forEach(a=>actionSchema.parse(a)); // Validate every step before the first write.
  const deadline = Date.now()+(request.timeoutMs ?? 180_000);
  for (const action of sequence) {
    const remaining = deadline-Date.now();
    const result = await actions.execute(action,{signal:remaining<=0 ? AbortSignal.abort() : request.signal,timeoutMs:Math.max(1,Math.min(300_000,remaining))});
    results.push(result);
    if (result.status!=='succeeded') break;
  }
  return results;
}
