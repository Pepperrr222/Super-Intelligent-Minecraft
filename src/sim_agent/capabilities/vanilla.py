"""Vanilla-only capabilities, shared by prompts and policy checks."""
CAPABILITIES = {
    "observe": {"effect": "read_only", "body_lock": False},
    "find_blocks": {"effect": "read_loaded_blocks", "body_lock": False},
    "recipes": {"effect": "read_vanilla_registry", "body_lock": False},
    "inspect_container": {"effect": "may_move_and_open_window", "body_lock": True},
    "goto": {"effect": "move", "body_lock": True},
    "follow": {"effect": "move_for_finite_duration", "body_lock": True},
    "collect": {"effect": "break_blocks_and_pick_up", "body_lock": True},
    "craft": {"effect": "consume_and_produce", "body_lock": True},
    "deposit": {"effect": "transfer_to_container", "body_lock": True},
    "withdraw": {"effect": "transfer_from_container", "body_lock": True},
    "smelt": {"effect": "consume_input_and_fuel", "body_lock": True},
}
READ_ONLY = {"observe", "find_blocks", "recipes"}
