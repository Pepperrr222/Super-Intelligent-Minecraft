"""Explicit root lifecycle; terminal runs are immutable."""
from sim_agent.domain.errors import ValidationError

TERMINAL = frozenset({"completed", "failed", "cancelled", "exhausted", "superseded"})
NORMAL = {
    "received": {"interpreting"},
    "interpreting": {"planning", "verifying", "waiting_input"},
    "planning": {"interpreting", "executing", "verifying", "waiting_input"},
    "executing": {"planning", "verifying", "waiting_input"},
    "verifying": {"planning", "delivering", "waiting_input"},
    "delivering": {"completed", "waiting_input"},
    "waiting_input": {"interpreting", "planning"},
    "interrupted": {"interpreting", "verifying", "delivering", "waiting_input"},
    "cancelling": {"cancelled", "superseded", "interrupted", "failed", "exhausted"},
}


def transition(current, target):
    if current == target: return target
    if current in TERMINAL: raise ValidationError("终态不能复活")
    if target in NORMAL.get(current, set()) | {"cancelling", "interrupted", "failed", "exhausted"}:
        return target
    raise ValidationError(f"非法状态转移 {current} -> {target}")
