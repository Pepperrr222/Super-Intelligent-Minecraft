import type { Bot } from 'mineflayer';
import { ActionError } from './executor.js';

type Part = 'head' | 'body' | 'legs' | 'feet';
const positive = (value: unknown): value is number => typeof value==='number' && Number.isFinite(value) && value>0;

/** A vertical aiming point, not a model bone location or continuous tracker. */
export function entityLookTarget(bot: Bot, entity: Bot['entity'], part: Part) {
  const origin = entity.position.clone();
  if (![origin.x,origin.y,origin.z].every(Number.isFinite)) throw new ActionError('INVALID_TARGET_POSITION','实体坐标不可用');
  if (part==='feet') return { position:origin, heightOffset:0, heightSource:'entity_position' };

  const player = entity.type==='player' || entity.name==='player' || Boolean(entity.username);
  const data = bot.registry.entitiesByName[player ? 'player' : (entity.name ?? '')];
  const keys = (data as {metadataKeys?: string[]} | undefined)?.metadataKeys;
  const poseIndex = keys?.indexOf('pose') ?? -1;
  const metadata = entity.metadata as Record<number,unknown> | undefined;
  const pose = poseIndex>=0 ? metadata?.[poseIndex] : undefined;
  // Native entities.js assigns these fields; prismarine-entity declarations omit them.
  const runtime = entity as Bot['entity'] & {eyeHeight?:number;crouching?:boolean};
  let height: number | undefined = entity.height;
  let head = runtime.eyeHeight;
  let heightSource = 'entity_dimensions';

  if (player) {
    // Java 1.21.1 Pose ordinals: standing=0, fall_flying=1, sleeping=2,
    // swimming/crawling=3, spin_attack=4, crouching=5, dying=6.
    // Mineflayer currently updates crouch dimensions but leaves some other poses stale.
    if (pose===1 || pose===3 || pose===4) {
      height=0.6; head=0.4; heightSource='player_low_pose';
    } else if (pose===5 || (pose===undefined && runtime.crouching)) {
      height=1.5; head=1.27; heightSource='player_crouching';
    } else if (pose===0) {
      height=1.8; head=1.62; heightSource='player_standing';
    } else if (pose!==undefined) {
      throw new ActionError('UNSUPPORTED_POSE','此玩家姿态尚未定义部位高度，请使用坐标看向或选择feet');
    } else if (!positive(height)) {
      height=1.8; head=1.62; heightSource='player_standing_estimate';
    }
  }
  if (!positive(height)) {
    height=data?.height ?? undefined;
    heightSource='registry_height_estimate';
  }
  if (!positive(height)) throw new ActionError('UNKNOWN_ENTITY_HEIGHT','实体高度未知，不能推测部位位置');
  // Generic entity head positions are approximate; stale eye heights cannot exceed its body height.
  const headHeight = positive(head) && head<height ? head : height*0.9;
  const heightOffset = part==='head' ? headHeight : height*(part==='body' ? 0.6 : 0.35);
  return { position:origin.offset(0,heightOffset,0), heightOffset, heightSource };
}
