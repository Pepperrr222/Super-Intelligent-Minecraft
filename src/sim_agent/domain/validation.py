"""Allowlist validation for every model decision and tool argument.

The model can only select one of the documented operations.  Its arguments
are rebuilt from validated primitives; unknown keys, non-canonical item names,
out-of-range numbers and command/code-shaped fields are rejected before any
request is sent to the executor.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any

from sim_agent.domain.errors import ValidationError

CANONICAL_ITEM_RE = re.compile(r"^minecraft:[a-z0-9_]{1,64}$")
PLAYER_RE = re.compile(r"^[A-Za-z0-9_]{1,16}$")

QUERY_OPS = frozenset({"observe", "find_blocks", "inspect_container", "recipes"})
ACTION_KINDS = frozenset(
    {"goto", "follow", "collect", "craft", "deposit", "withdraw", "smelt"}
)
STEP_OPS = QUERY_OPS | {"act", "finish", "clarify"}

FORBIDDEN_KEY_FRAGMENTS = (
    "command",
    "script",
    "javascript",
    "eval",
    "exec",
    "shell",
    "rawcode",
)

MAX_COUNT = 2304  # generous inventory goal bound; individual actions stay <=64


def _mapping(value: Any, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{where} 必须是对象")
    return value


def _exact_keys(
    value: dict[str, Any],
    where: str,
    *,
    required: set[str],
    optional: set[str] | None = None,
) -> None:
    allowed = set(required) | set(optional or ())
    missing = required - set(value)
    if missing:
        raise ValidationError(f"{where} 缺少字段: {', '.join(sorted(missing))}")
    extra = set(value) - allowed
    if extra:
        raise ValidationError(f"{where} 含不允许的字段: {', '.join(sorted(map(str, extra)))}")


def _reject_forbidden_keys(value: Any, where: str, depth: int = 0) -> None:
    if depth > 6:
        raise ValidationError(f"{where} 嵌套过深")
    if isinstance(value, dict):
        for key, child in value.items():
            lowered = str(key).lower()
            if any(fragment in lowered for fragment in FORBIDDEN_KEY_FRAGMENTS):
                raise ValidationError(f"{where} 不允许字段 {key}")
            _reject_forbidden_keys(child, f"{where}.{key}", depth + 1)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_forbidden_keys(child, f"{where}[{index}]", depth + 1)


def _string(value: Any, where: str, *, max_len: int = 200, allow_slash: bool = False) -> str:
    if not isinstance(value, str):
        raise ValidationError(f"{where} 必须是字符串")
    if not value.strip():
        raise ValidationError(f"{where} 不能为空")
    if len(value) > max_len:
        raise ValidationError(f"{where} 过长")
    if any(ord(ch) < 32 for ch in value):
        raise ValidationError(f"{where} 不能包含控制字符")
    if not allow_slash and value.lstrip().startswith("/"):
        raise ValidationError(f"{where} 不能是服务器命令")
    return value


def canonical_item(value: Any, where: str = "item") -> str:
    item = _string(value, where, max_len=80)
    if not CANONICAL_ITEM_RE.fullmatch(item):
        raise ValidationError(
            f"{where} 必须是规范命名空间 ID，例如 minecraft:oak_log"
        )
    return item


def canonical_observed_name(value: Any) -> str | None:
    """Best-effort canonicalisation for executor observations only."""

    if not isinstance(value, str) or not value:
        return None
    name = value.strip().lower()
    if ":" not in name:
        name = "minecraft:" + name
    if CANONICAL_ITEM_RE.fullmatch(name):
        return name
    return None


def player_name(value: Any, where: str = "player") -> str:
    player = _string(value, where, max_len=16)
    if not PLAYER_RE.fullmatch(player):
        raise ValidationError(f"{where} 必须是 1..16 位字母数字下划线玩家名")
    return player


def _number_value(value: Any, where: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError(f"{where} 必须是数字")
    number = float(value)
    if not math.isfinite(number):
        raise ValidationError(f"{where} 必须是有限数字")
    return number


def position(value: Any, where: str = "position") -> dict[str, float]:
    raw = _mapping(value, where)
    _exact_keys(raw, where, required={"x", "y", "z"})
    result: dict[str, float] = {}
    for axis in ("x", "y", "z"):
        number = _number_value(raw[axis], f"{where}.{axis}")
        if abs(number) > 30_000_000:
            raise ValidationError(f"{where}.{axis} 超出世界范围")
        result[axis] = number
    return result


def _int_range(value: Any, where: str, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValidationError(f"{where} 必须是整数")
    if not lo <= value <= hi:
        raise ValidationError(f"{where} 必须在 {lo}..{hi} 之间")
    return value


@dataclass(frozen=True, slots=True)
class ToolCall:
    op: str
    args: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {"op": self.op, "args": self.args}


@dataclass(frozen=True, slots=True)
class Decision:
    goal: dict[str, Any] | None
    step: ToolCall
    message: str

    def to_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {"step": self.step.to_dict()}
        if self.goal is not None:
            value["goal"] = self.goal
        if self.message:
            value["message"] = self.message
        return value


def _validate_action(args: dict[str, Any]) -> dict[str, Any]:
    kind = args.get("kind")
    if not isinstance(kind, str) or kind not in ACTION_KINDS:
        raise ValidationError(f"act.kind 必须是 {', '.join(sorted(ACTION_KINDS))}")
    if kind == "goto":
        _exact_keys(args, "act", required={"kind", "position"}, optional={"range"})
        return {
            "kind": kind,
            "position": position(args["position"], "act.position"),
            "range": _int_range(args.get("range", 1), "act.range", 1, 4),
        }
    if kind == "follow":
        _exact_keys(args, "act", required={"kind", "player", "duration_seconds"})
        return {
            "kind": kind,
            "player": player_name(args["player"], "act.player"),
            "duration_seconds": _int_range(
                args["duration_seconds"], "act.duration_seconds", 1, 60
            ),
        }
    if kind == "collect":
        _exact_keys(args, "act", required={"kind", "block", "count"})
        return {
            "kind": kind,
            "block": canonical_item(args["block"], "act.block"),
            "count": _int_range(args["count"], "act.count", 1, 64),
        }
    if kind == "craft":
        _exact_keys(args, "act", required={"kind", "item", "count"})
        return {
            "kind": kind,
            "item": canonical_item(args["item"], "act.item"),
            "count": _int_range(args["count"], "act.count", 1, 64),
        }
    if kind in {"deposit", "withdraw"}:
        _exact_keys(args, "act", required={"kind", "position", "item", "count"})
        return {
            "kind": kind,
            "position": position(args["position"], "act.position"),
            "item": canonical_item(args["item"], "act.item"),
            "count": _int_range(args["count"], "act.count", 1, 64),
        }
    # smelt
    _exact_keys(
        args,
        "act",
        required={
            "kind",
            "position",
            "input",
            "fuel",
            "input_count",
            "fuel_count",
            "wait_seconds",
        },
    )
    return {
        "kind": kind,
        "position": position(args["position"], "act.position"),
        "input": canonical_item(args["input"], "act.input"),
        "fuel": canonical_item(args["fuel"], "act.fuel"),
        "input_count": _int_range(args["input_count"], "act.input_count", 1, 64),
        "fuel_count": _int_range(args["fuel_count"], "act.fuel_count", 1, 64),
        "wait_seconds": _int_range(args["wait_seconds"], "act.wait_seconds", 1, 120),
    }


def validate_step(raw: Any) -> ToolCall:
    step = _mapping(raw, "step")
    _exact_keys(step, "step", required={"op"}, optional={"args"})
    _reject_forbidden_keys(step, "step")
    op = step.get("op")
    if not isinstance(op, str) or op not in STEP_OPS:
        raise ValidationError(
            f"step.op 必须是 {', '.join(sorted(STEP_OPS))} 之一"
        )
    args_raw = step.get("args", {})
    args = _mapping(args_raw, f"step({op}).args")

    if op == "observe":
        _exact_keys(args, "observe.args", required=set())
        return ToolCall(op, {})
    if op == "find_blocks":
        _exact_keys(args, "find_blocks.args", required={"names", "radius", "limit"})
        names = args["names"]
        if not isinstance(names, list) or not 1 <= len(names) <= 8:
            raise ValidationError("find_blocks.names 必须包含 1..8 个方块 ID")
        canonical_names = [
            canonical_item(name, f"find_blocks.names[{index}]")
            for index, name in enumerate(names)
        ]
        if len(set(canonical_names)) != len(canonical_names):
            raise ValidationError("find_blocks.names 不能重复")
        return ToolCall(
            op,
            {
                "names": canonical_names,
                "radius": _int_range(args["radius"], "find_blocks.radius", 1, 32),
                "limit": _int_range(args["limit"], "find_blocks.limit", 1, 16),
            },
        )
    if op == "inspect_container":
        _exact_keys(args, "inspect_container.args", required={"position"})
        return ToolCall(op, {"position": position(args["position"])})
    if op == "recipes":
        _exact_keys(args, "recipes.args", required={"item"})
        return ToolCall(op, {"item": canonical_item(args["item"])})
    if op == "act":
        return ToolCall(op, _validate_action(args))
    if op == "finish":
        _exact_keys(args, "finish.args", required=set())
        return ToolCall(op, {})
    # clarify
    _exact_keys(args, "clarify.args", required=set(), optional={"question"})
    normalized: dict[str, Any] = {}
    if "question" in args:
        normalized["question"] = _string(
            args["question"], "clarify.question", max_len=300, allow_slash=True
        )
    return ToolCall(op, normalized)


def parse_decision(text: str) -> Decision:
    """Parse exactly one JSON decision object; reject everything else."""

    if not isinstance(text, str):
        raise ValidationError("模型输出必须是字符串")
    if len(text) > 200_000:
        raise ValidationError("模型输出过长")
    stripped = text.strip()
    if not stripped:
        raise ValidationError("模型输出为空")
    if not stripped.startswith("{"):
        raise ValidationError("模型输出必须是一个 JSON 对象（不允许 Markdown 包装）")
    try:
        raw = json.loads(stripped)
    except json.JSONDecodeError as exc:
        raise ValidationError(f"模型输出不是有效 JSON（第 {exc.lineno} 列 {exc.colno}）") from exc
    if not isinstance(raw, dict):
        raise ValidationError("模型输出根节点必须是对象")
    _exact_keys(raw, "decision", required={"step"}, optional={"goal", "message"})
    _reject_forbidden_keys(raw, "decision")
    goal = raw.get("goal")
    if goal is not None and not isinstance(goal, dict):
        raise ValidationError("decision.goal 必须是对象")
    message_raw = raw.get("message", "")
    message = ""
    if message_raw is not None and message_raw != "":
        message = _string(message_raw, "decision.message", max_len=500, allow_slash=True)
    step = validate_step(raw["step"])
    return Decision(goal=goal, step=step, message=message)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
