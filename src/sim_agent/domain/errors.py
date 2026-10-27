"""Error types used across the basic agent.

None of these errors should ever contain an API key or a complete HTTP
response body.  They are deliberately terse so they can be persisted in the
JSONL task log and shown to the player.
"""

from __future__ import annotations


class AgentError(Exception):
    """Base class for expected agent failures."""


class ConfigError(AgentError):
    """The configuration file is missing or invalid."""


class ValidationError(AgentError):
    """A model decision, goal or tool argument violated the contract."""


class WorldChangedError(AgentError):
    """The observed world_id changed; the old task must not continue."""


class TransportError(AgentError):
    """The executor child could not be used."""


class TransportTimeout(TransportError):
    """A JSONL request did not receive its correlated response in time."""


class ExecutorError(TransportError):
    """The executor returned ``{ok: false}``."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"执行器错误 [{code}]: {message}")


class ModelError(AgentError):
    """The language-model request failed."""


class ModelTimeout(ModelError):
    """The language-model request exceeded its configured deadline."""


class DeadlineExceeded(AgentError):
    """The task's wall-clock limit has been reached."""


class OperationTimeout(AgentError):
    """One protocol/model operation exceeded its own timeout."""


class TaskCancelled(AgentError):
    """The current task was cancelled by the player, disconnect or shutdown."""
