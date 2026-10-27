"""Strict-ish loading of the configuration contract in docs/PROTOCOL.md.

Secret *paths* only: this module never reads the model key file.  The key is
read lazily and only by :mod:`sim_agent.planning.model`.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sim_agent.domain.errors import ConfigError


@dataclass(frozen=True, slots=True)
class MinecraftConfig:
    host: str
    port: int
    version: str
    username: str
    auth: str
    world_id: str


@dataclass(frozen=True, slots=True)
class AgentConfig:
    owner: str
    prefix: str
    max_steps: int
    task_timeout_seconds: float
    poll_seconds: float


@dataclass(frozen=True, slots=True)
class ModelConfig:
    base_url: str
    name: str
    key_file: Path
    timeout_seconds: float


@dataclass(frozen=True, slots=True)
class LearningConfig:
    mode: str = "B0"
    ruleset_id: str = "vanilla-1.21.1-v1"
    max_retrieved: int = 3


@dataclass(frozen=True, slots=True)
class AppConfig:
    minecraft: MinecraftConfig
    agent: AgentConfig
    model: ModelConfig
    runtime_dir: Path
    config_path: Path
    raw: dict[str, Any]
    learning: LearningConfig = field(default_factory=LearningConfig)


def _section(root: dict[str, Any], name: str) -> dict[str, Any]:
    value = root.get(name)
    if not isinstance(value, dict):
        raise ConfigError(f"配置缺少对象字段 {name}")
    return value


def _text(section: dict[str, Any], key: str, where: str, *, max_len: int = 512) -> str:
    value = section.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"配置 {where}.{key} 必须是非空字符串")
    if len(value) > max_len:
        raise ConfigError(f"配置 {where}.{key} 过长")
    return value


def _int(section: dict[str, Any], key: str, where: str, lo: int, hi: int) -> int:
    value = section.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"配置 {where}.{key} 必须是整数")
    if not lo <= value <= hi:
        raise ConfigError(f"配置 {where}.{key} 必须在 {lo}..{hi} 之间")
    return value


def _number(
    section: dict[str, Any],
    key: str,
    where: str,
    lo: float,
    hi: float,
) -> float:
    value = section.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ConfigError(f"配置 {where}.{key} 必须是数字")
    number = float(value)
    if not math.isfinite(number) or not lo <= number <= hi:
        raise ConfigError(f"配置 {where}.{key} 必须在 {lo}..{hi} 之间")
    return number


def load_config(path: str | Path) -> AppConfig:
    config_path = Path(path).expanduser().resolve()
    try:
        text = config_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"无法读取配置文件 {config_path}") from exc
    try:
        root = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"配置文件不是有效 JSON（第 {exc.lineno} 行）") from exc
    if not isinstance(root, dict):
        raise ConfigError("配置文件根节点必须是对象")

    mc_raw = _section(root, "minecraft")
    agent_raw = _section(root, "agent")
    model_raw = _section(root, "model")

    host = _text(mc_raw, "host", "minecraft", max_len=253)
    port = _int(mc_raw, "port", "minecraft", 1, 65535)
    version = _text(mc_raw, "version", "minecraft", max_len=32)
    username = _text(mc_raw, "username", "minecraft", max_len=32)
    auth = _text(mc_raw, "auth", "minecraft", max_len=32)
    world_id = _text(mc_raw, "world_id", "minecraft", max_len=128)

    owner = _text(agent_raw, "owner", "agent", max_len=32)
    prefix = _text(agent_raw, "prefix", "agent", max_len=64)
    max_steps = _int(agent_raw, "max_steps", "agent", 1, 100)
    task_timeout = _number(agent_raw, "task_timeout_seconds", "agent", 1.0, 3600.0)
    poll_seconds = _number(agent_raw, "poll_seconds", "agent", 0.05, 5.0)

    base_url = _text(model_raw, "base_url", "model", max_len=512)
    if not (base_url.startswith("https://") or base_url.startswith("http://")):
        raise ConfigError("配置 model.base_url 必须以 http:// 或 https:// 开头")
    model_name = _text(model_raw, "name", "model", max_len=128)
    key_file_raw = _text(model_raw, "key_file", "model", max_len=4096)
    model_timeout = _number(model_raw, "timeout_seconds", "model", 1.0, 300.0)
    key_file = Path(key_file_raw).expanduser()
    if not key_file.is_absolute():
        key_file = config_path.parent / key_file

    learning_raw = root.get("learning", {})
    if not isinstance(learning_raw, dict):
        raise ConfigError("配置 learning 必须是对象")
    mode = learning_raw.get("mode", "B0")
    if mode not in {"B0", "B1"}:
        raise ConfigError("当前仅支持 B0/B1；B2/B3 尚未接入自动技能执行")
    ruleset_id = learning_raw.get("ruleset_id", "vanilla-1.21.1-v1")
    if not isinstance(ruleset_id, str) or not ruleset_id.strip() or len(ruleset_id) > 128:
        raise ConfigError("learning.ruleset_id 必须是 1..128 字符的规则版本标签")
    max_retrieved = learning_raw.get("max_retrieved", 3)
    if isinstance(max_retrieved, bool) or not isinstance(max_retrieved, int) or not 1 <= max_retrieved <= 3:
        raise ConfigError("learning.max_retrieved 必须是 1..3 的整数")

    runtime_raw = root.get("runtime_dir")
    if not isinstance(runtime_raw, str) or not runtime_raw.strip():
        raise ConfigError("配置 runtime_dir 必须是非空字符串")
    runtime_path = Path(runtime_raw).expanduser()
    if not runtime_path.is_absolute():
        # Keep runtime artifacts next to the project/config rather than making
        # them depend on the shell's current directory.
        runtime_path = config_path.parent / runtime_path

    return AppConfig(
        minecraft=MinecraftConfig(
            host=host,
            port=port,
            version=version,
            username=username,
            auth=auth,
            world_id=world_id,
        ),
        agent=AgentConfig(
            owner=owner,
            prefix=prefix,
            max_steps=max_steps,
            task_timeout_seconds=task_timeout,
            poll_seconds=poll_seconds,
        ),
        model=ModelConfig(
            base_url=base_url,
            name=model_name,
            key_file=key_file,
            timeout_seconds=model_timeout,
        ),
        runtime_dir=runtime_path,
        config_path=config_path,
        raw=root,
        learning=LearningConfig(mode, ruleset_id, max_retrieved),
    )
