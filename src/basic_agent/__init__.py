"""Basic Minecraft Java 1.21.1 agent (decision layer).

The package talks to the Node executor over UTF-8 JSON Lines and never
executes generated JavaScript, chat commands or arbitrary Python supplied by
the model.
"""

from __future__ import annotations

__version__ = "0.1.0"

__all__ = ["__version__"]
