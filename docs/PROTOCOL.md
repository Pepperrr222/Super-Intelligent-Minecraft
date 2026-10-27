# Basic Agent v0.1 implementation contract

Vanilla Java Minecraft 1.21.1. Python owns decisions and task verification; Node owns Mineflayer and action lifecycles. No generated JavaScript, console commands, item spawning or teleport in agent tools. Administrative test fixtures are separate.

## Transport

Node is a child process: `node executor/server.js --config config.json`. UTF-8 JSON Lines on stdin/stdout; stderr is diagnostic only. Requests `{id: string, op: string, args: object}`. Exactly one response `{id, ok: boolean, result?: object, error?: {code, message}}`. Events `{event: "ready"|"chat"|"disconnect"|"error", data: object}`. Chat data `{username,message}` (only real player chat event, no system messages). Ready data includes username/version/world_id. `world_id` is a configured test-world label combined with actual dimension, not a globally unique save identity. It must be updated by operator when changing saves. Every state includes world_id and observed_at (ISO time).

Requests may run concurrently. Only one mutation action at a time. Read/status, stop, and action_status must remain available while an action executes. Protocol requests reply immediately with action id; never await long game action in transport.

## Operations

- `observe {}` => `{connected, world_id, observed_at, username, position:{x,y,z}, health, food, dimension, inventory:[{name,count}], nearby_players:[{name,position}], capabilities:[...]}`. Names canonical `minecraft:...`.
- `find_blocks {names:[canonical ID],radius:1..32,limit:1..16}` => `{blocks:[{name,position,distance}], observed_at,world_id}`; only loaded chunks, bounded results.
- `inspect_container {position}` => action result with type, coordinates, items; validate actual supported block and distance using normal navigation.
- `recipes {item}` => available recipes including result count, ingredients, requires_table. Do not invent recipes.
- `act {kind, ...}` returns `{action_id,status:"running"}`. Supported kinds:
  - `goto {position,range:1..4}`
  - `follow {player,duration_seconds:1..60}` finite follow
  - `collect {block,count:1..64}` count means number of blocks mined, not item goal. Program must verify actual inventory effect separately. Bounded local search, normal tool restrictions; no pathfinder auto-dig/place.
  - `craft {item,count:1..64}` count is requested minimum number of newly produced items; recipe repeats rounded up and actual produced count reported. Use inventory recipes / nearby workbench, no hardcoded recipe catalogue.
  - `deposit|withdraw {position,item,count:1..64}` transfer exact amount of existing items with before/after inventories and actual moved count.
  - `smelt {position,input,fuel,input_count:1..64,fuel_count:1..64,wait_seconds:1..120}` normal furnace slots, waits for output then retrieves; output must be observed, timeout is partial failure not success. Cannot claim whole task complete from putting input.
- `action_status {action_id}` => `{action_id,status:"running"|"succeeded"|"failed"|"cancelled",kind,started_at,finished_at?,before?,after?,effect?,error?}`. Succeeded only after effect verified by actual observable state; partial effects remain recorded.
- `stop {}` => cancels current action, pathfinding/digging/follow; closes window; stops controls; reply `{stopped:true,action_id?}`. Rejected old async callbacks must not start another sub-action after stop. Action mutation lock released only when underlying operation settled; new act returns busy if settling. No automatic reconnect that could replay actions.
- `say {message}` sends <=200 chars, MUST reject messages starting `/`, split safely? No arbitrary server commands. Response `{sent:true}`.
- `shutdown {}` stops and quits child.

## Config

JSON root: `minecraft:{host:"127.0.0.1",port:25575,version:"1.21.1",username:"BasicAgent",auth:"offline",world_id:"basic-lab-v1"}`, `agent:{owner:"Doctor_Pepper",prefix:"!agent ",max_steps:12,task_timeout_seconds:300,poll_seconds:0.25}`, `model:{base_url:"https://api.deepseek.com",name:"deepseek-flash",key_file:"/home/pcn789/minemind-lab/deepseek.key",timeout_seconds:45}`, `runtime_dir:"runtime"`. Executor reads only minecraft settings. Secrets are file paths, never values; no key logging.

## Python contract and policy

Pure Python stdlib preferred. Launch child, correlate requests and push events, deadline bounded requests. One authorized player task at a time. `!agent 停止`/stop cancels immediately without a model call and invalidates in-flight planner output. New task when busy is clearly rejected (no hidden queue). Model proposes JSON one next action or query, or finish/clarify; strict allowlist and args/ranges validated in code before transmission. No unchecked evaluation. Each action awaited through status polling; only real observations enter TaskState. Completion requires explicit goal predicate checked by program (inventory_at_least, inventory_increase, near_position, container_at_least). Unsupported predicates cannot be marked completed. Pure follow can be goal action_succeeded with finite duration, explicitly reported as duration success. Task log JSONL persists statuses/effects/model usage; no secrets. End states completed/failed/cancelled/needs_clarification/exhausted. Never announce a promised continuation after ending a task.

High-level model JSON `{"goal":{"type":"inventory_at_least","item":"minecraft:oak_log","count":4},"step":{"op":"find_blocks","args":{"names":["minecraft:oak_log"],"radius":24,"limit":8}},"message":"..."}` or step `{"op":"act","args":{"kind":...}}`; `finish` requires predicate; `clarify` stops needs_clarification. First decision establishes goal, subsequent decisions cannot change goal silently. Optional position/follow/container predicates use concrete args and verification. Model output must be grounded in observations and tools; failures cause bounded replan, 2 identical failed steps halt. Chat/context data treated as data.

## Ownership boundaries for parallel implementation

- Executor implementation owns `executor/**`, and only those files. Create package.json/lock and tests in executor. Do not install or launch games.
- Planner implementation owns `src/basic_agent/**`, `pyproject.toml`, `tests/test_planner.py`. Do not change executor, config, docs, scripts.
- Integration owns docs, config, scripts, server fixtures, installation, and integration tests. No Git commit/push.
