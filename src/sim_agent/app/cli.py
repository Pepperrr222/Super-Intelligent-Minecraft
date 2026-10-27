"""Command-line entry point.

Examples::

    python -m sim_agent --config config.json
    python -m sim_agent --config config.json --task "收集 4 个橡木原木"
    python -m sim_agent --config config.json --task "去坐标 0 64 0" \
        --goal-json '{"type":"near_position","position":{"x":0,"y":64,"z":0},"range":2}'
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from sim_agent import __version__
from sim_agent.app.config import load_config
from sim_agent.domain.errors import AgentError, ConfigError, ValidationError
from sim_agent.domain.goals import parse_goal
from sim_agent.observability.jsonl import RuntimeLogs
from sim_agent.planning.model import DeepSeekClient
from sim_agent.planning.planner import LLMPlanner
from sim_agent.execution.service import AgentService
from sim_agent.adapters.mineflayer import ExecutorClient
from sim_agent.memory.store import ExperienceStore


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m sim_agent",
        description="Minecraft Java 1.21.1 基础 Agent（Python 决策层）",
    )
    parser.add_argument(
        "--config",
        default="config.json",
        help="配置文件路径（默认 config.json）",
    )
    parser.add_argument(
        "--task",
        help="终端单次任务文本；不传时监听配置 owner 的游戏聊天",
    )
    parser.add_argument(
        "--goal-json",
        help=(
            "可选的显式 goal 谓词：内联 JSON、@文件路径或 .json 文件路径"
            "（仍需模型逐步决策并由程序验证）"
        ),
    )
    parser.add_argument("--version", action="version", version=__version__)
    return parser


def _parse_goal_arg(raw: str | None) -> dict[str, Any] | None:
    if raw is None:
        return None
    text = raw.strip()
    if text.startswith("@"):
        try:
            text = Path(text[1:]).expanduser().read_text(encoding="utf-8")
        except OSError as exc:
            raise ValidationError("无法读取 --goal-json 文件") from exc
    elif text.startswith("{"):
        pass
    else:
        candidate = Path(text).expanduser()
        if candidate.is_file():
            try:
                text = candidate.read_text(encoding="utf-8")
            except OSError as exc:
                raise ValidationError("无法读取 --goal-json 文件") from exc
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValidationError(f"--goal-json 不是有效 JSON（第 {exc.lineno} 行）") from exc
    goal = parse_goal(value)
    return goal.to_dict()


async def _run(args: argparse.Namespace, config: Any, goal_json: dict[str, Any] | None) -> int:
    logs = RuntimeLogs(config.runtime_dir)
    memory = ExperienceStore(config.runtime_dir / "memory.sqlite3")
    backend = ExecutorClient(config, logs)
    planner = LLMPlanner(DeepSeekClient(config.model))
    service = AgentService(
        backend,
        planner,
        config,
        logs,
        emit=lambda text: print(text, flush=True),
        chat_progress=args.task is None,
        memory=memory,
    )
    started = False
    try:
        print("正在连接执行器…", flush=True)
        ready = await service.start()
        started = True
        username = ready.get("username", config.minecraft.username)
        version = ready.get("version", config.minecraft.version)
        world_id = ready.get("world_id", config.minecraft.world_id)
        print(f"已连接：{username} / {version} / {world_id}", flush=True)

        if args.task is not None:
            if not args.task.strip():
                print("错误：--task 不能为空。", file=sys.stderr)
                return 2
            outcome = await service.run_single(args.task, goal_json)
            print("", flush=True)
            print(outcome.message, flush=True)
            print(
                f"状态：{outcome.end_state}，步数：{len(outcome.steps)}，"
                f"用时：{outcome.duration_seconds:.1f} 秒",
                flush=True,
            )
            return 0 if outcome.completed else 1

        print(
            f"监听聊天：玩家 {config.agent.owner}，前缀 {config.agent.prefix!r}。"
            "发送“停止”可取消当前任务。",
            flush=True,
        )
        await service.run_forever()
        return 0
    finally:
        try:
            if started:
                await service.shutdown()
            else:
                await backend.shutdown()
        except Exception:
            pass
        logs.close()
        memory.close()


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.goal_json is not None and args.task is None:
        parser.error("--goal-json 只能与 --task 一起使用")
    try:
        config = load_config(Path(args.config))
        goal_json = _parse_goal_arg(args.goal_json)
    except (ConfigError, ValidationError) as exc:
        print(f"配置错误：{exc}", file=sys.stderr)
        return 2
    try:
        return asyncio.run(_run(args, config, goal_json))
    except KeyboardInterrupt:
        print("\n已中断。", file=sys.stderr)
        return 130
    except (ConfigError, ValidationError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2
    except AgentError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
