# JSONL protocol v0.2

单动作诊断 --action-debug 复用本文的 observe、act、action_status、stop 协议，不新增 Node 字段。collect.count 仍表示方块数；原木调试任务由 Python 额外验证目标库存增量与挖掘证据。参见 [动作调试](ACTION_DEBUG.md)。

采集可靠性修订不新增请求参数；action_status.effect 允许附带阶段、目标掉落、确认挖掘、接近尝试与失败候选等可选诊断快照。effect_unknown=true 表示未确认的游戏副作用，不能因动作返回failed就允许自动重放。当前Python控制器会停止后续变更，双层动作日志保留unknown。详见 [采集复测](implementation/COLLECT_RELIABILITY.md)。

Minecraft Java 1.21.1, Python orchestrator and Node Mineflayer executor. Start the child with `node executor/server.js --config <absolute-config-path>`.

## Envelope and lifecycle

UTF-8 JSON Lines on stdin/stdout. Diagnostic output uses stderr. Request:

```json
{"id":"py-1","op":"observe","args":{}}
```

Exactly one correlated response is returned:

```json
{"id":"py-1","ok":true,"result":{}}
```

Errors use `{"id":"py-1","ok":false,"error":{"code":"...","message":"..."}}`. Unsolicited events use `{"event":"ready|chat|disconnect|error","data":{}}`.

Requests may run concurrently, but only one mutation action or container inspection may control the bot. Actions return an action_id immediately; status, observe and stop remain responsive. There is no arbitrary code or server-console tool.

## Read operations

| op | args | result |
| --- | --- | --- |
| observe | `{}` | connected, world_id, observed_at, username, position, health, food, dimension, inventory, nearby_players, capabilities |
| find_blocks | names canonical IDs, radius 1..32, limit 1..16 | loaded blocks with names, positions and distances |
| recipes | item canonical ID | recipes from current Mineflayer registry, including counts and ingredients |
| inspect_container | position `{x,y,z}` | current executor returns type, position, items, world_id and observed_at after inspection; Python also accepts asynchronous action_id responses from future adapters |
| action_status | action_id | running/succeeded/failed/cancelled, before/after, effect, error and timestamps |

Item names currently require `minecraft:...`. Unknown/unloaded is distinct from observed empty. world_id is the configured save label plus actual dimension; operators must change the label for a different save. Observations include timestamps.

## act operation

`{"op":"act","args":{"kind":"...", ...}}` accepts:

| kind | parameters | quantity meaning |
| --- | --- | --- |
| goto | position, range 1..4 | actual Euclidean arrival tolerance |
| follow | player, duration_seconds 1..60 | finite follow only |
| collect | block, count 1..64 | number of blocks; actual item gain verified separately |
| craft | item, count 1..64 | minimum newly produced output; rounds up recipe repetitions |
| deposit / withdraw | position, item, count 1..64 | exact transfer amount; checks both inventory deltas |
| smelt | position, input, fuel, input_count 1..64, fuel_count 1..64, wait_seconds 1..120 | waits for observed output and retrieves it |

Pathfinding does not dig or place blocks automatically. Only standard supported containers and furnaces are handled. A backend request acknowledgement never proves completion.

`stop {}` cancels pathfinding, digging and pending continuations, closes windows and clears control state. It returns promptly; the mutation lock remains held until the old operation settles. Stop/timeout does not undo prior world changes. Preserve partial evidence and inspect before retrying a non-idempotent transfer. action_id identifies a submitted operation; it is not a client-provided exactly-once request key.

`say {message}` sends at most 200 characters and rejects slash commands/control characters. `shutdown {}` stops and quits. No automatic reconnect replays tasks.

## Hierarchical model proposal (opt-in)

The model-facing shorthand may be a flat object: `{operation, reason, ...operationFields}`.
Python deterministically supplies `schema_version`, the role envelope and `payload`; action arguments and semantic checks remain unchanged.
Existing complete envelopes remain accepted. Malformed JSON, unknown fields or operations are still rejected.
Model-visible evidence IDs use short aliases; Python restores existing persistent IDs only in evidence-reference fields.
`collected_at_least {item,count}` verifies cumulative item gains in confirmed collect outcomes for the current root task,
deduplicated by action ID. Later consumption does not undo collection. It uses root scope, unlike final inventory predicates.
Optional `public_scene` on `AgentService.run_single` / `TaskRuntime.run` supplies public environment facts separately from the user's task; it is not a hidden grader input.

Explicit `act` kind `place` accepts `{item,position}` with integer coordinates. It consumes one existing block item,
requires an empty target with solid support below, and verifies both the resulting block and inventory decrement.
Navigation and crafting still never place a workstation implicitly. Unconfirmed placement retains `effect_unknown`.

With orchestration.mode=hierarchical, the existing Node JSONL protocol is reused. Coordinator/Worker use distinct internal envelopes: schema_version, kind, summary, payload. The Coordinator proposes contracts/plans/dispatch/report/clarification; Worker proposes query/act/submit_result/blocked. Neither writes verified facts or completion directly. Schemas: implementation/VANILLA_AGENT_V1.md. Current limits: implementation/RUNNING.md.

All roles and retries share root budgets and version checks. Reporting is a first-class deliverable; a receipt means submitted, not read. TaskStore persists current-task snapshots and action journals separately from learning. Unknown actions/chat receipts do not automatically replay. Explicit continuation preserves baselines, effects and spent budgets. Only B0 is supported; no silent rules/legacy fallback.

## Legacy model proposal

```json
{
  "goal": {"type":"inventory_increase","item":"minecraft:oak_planks","count":8},
  "step": {"op":"recipes","args":{"item":"minecraft:oak_planks"}},
  "message": "先核对配方"
}
```

Allowed steps: observe, find_blocks, recipes, inspect_container, act, finish, clarify. Python validates arguments before sending. First decision binds the goal; later decisions cannot silently replace it. finish requires fresh independent verification. clarify ends needs_clarification and asks a concrete question.

Supported goals: inventory_at_least, inventory_increase, inventory_delta, near_position, container_at_least, container_delta, action_succeeded (finite follow), and all_of. Delta predicates are exact, signed changes from independently captured task baselines. all_of allows 1..8 children, at most 16 leaves and bounded nesting.

Optional model `constraints` accepts no_move/no_collect booleans, keep_inventory (canonical item to minimum count), and allowed_sources (container positions). Constraints lock with the goal and cannot be weakened. TaskSpec in context is generated by the program from the validated goal, constraints, observed bindings and task version.

Owner chat `!agent 纠正 ...` cancels the previous task before starting a new version with verified progress. `!agent 回答 ...` resumes a clarification with original request and answer context. Normal new work is rejected while busy. Chat progress is coalesced; important messages use a minimum interval to avoid vanilla spam kicks.

`agent.owner="*"` authorizes all players for tasks, stop, correction and clarification answers. A specific username retains single-player authorization. The bot always ignores its own chat; the configured prefix and single shared task lifecycle still apply. There is no per-player queue.

End states: completed, failed, cancelled, needs_clarification, exhausted. Same failure twice, step budget or deadline stops the loop. Late model responses after cancellation must not start actions.

## Persistence and configuration

Root config schema is illustrated in config.example.json. The Node child only retains the minecraft section; current executor accepts offline authentication only. Python resolves model.key_file and runtime_dir relative to the config file. Secrets are never embedded in public config.

Optional root `node_executable` selects a local Node binary or command; paths containing a directory resolve relative to the config file. Otherwise Python checks SIM_NODE and then PATH. This setting is local and is not passed as a game capability.

Model settings optionally include provider (generic/deepseek/siliconflow), thinking (boolean), stream (boolean, legacy default false), and max_tokens (128..8192). Vendor thinking flags are translated only for the chosen provider. HTTP redirects and truncated model output are rejected; credentials remain local. See MODELS.md for examples.

learning.mode supports B0/B1. B0 saves evidence without retrieving it. B1 retrieves at most three matching episodes; these are historical advice and do not bypass current action checks. ruleset_id is manually maintained, not automatically discovered.

Task records carry goals, observations, actions, result evidence, usage and terminal status. SQLite episodes are immutable by task_id; skills require explicit replay linkage and two independent successful scenarios before promotion. Templates remain data, with automatic skill execution reserved for B2/B3.

The separate trace.jsonl stream records proposal summaries, planning starts, model-call metadata, goal binding, dispatched steps, effects, rejections and final verification. A proposal event is not approval or completion. Explicitly observed provider reasoning_content and content are archived as separate reasoning / decision channels under model-calls/<call_id>.jsonl and a final .json snapshot. Generic logs still redact credential and raw-reasoning fields; full HTTP bodies, prompts and credentials are never archived.

Observed model calls emit model_start, model_delta(channel,text), model_end(status,usage,reasoning_status). Status is completed/cancelled/timed_out/truncated/interrupted/error; missing or disabled reasoning is separately identified. SSE requires a stop finish_reason and [DONE] before a final decision can return. A valid JSON prefix alone is insufficient. The dashboard's GET /api/calls/<call_id> accepts only generated call identifiers; it exposes no file browsing or execution operation. See DASHBOARD.md.

## 当前双层业务协议修订

Node JSONL 不变。正式 AgentTeam 的角色上下文为 business.v2：Coordinator 的 deliverables/stages 使用自然语言 completion_criteria，不指定 allowed_capabilities/acceptance_checks；request_information 只指定 question/evidence_refs。Worker 的 prepare_verification 编译根交付和阶段检查，程序冻结并建立动作前基线。无独立 reviewer 调用。具体字段、兼容和验证限制见 [架构修订](implementation/COORDINATOR_AUTONOMY.md)。旧内部契约只保留给回归夹具；旧 semantic_review 验收不能自动通过。
