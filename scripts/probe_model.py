"""Small real API connectivity check; never prints credentials or raw bodies."""
from __future__ import annotations
import argparse
import asyncio
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from sim_agent.app.config import load_config
from sim_agent.planning.model import DeepSeekClient
from sim_agent.domain.errors import AgentError


async def probe(config_path: Path) -> dict:
    config = load_config(config_path)
    record = {"provider": config.model.provider, "model": config.model.name, "thinking": config.model.thinking}
    started = time.monotonic()
    try:
        result = await DeepSeekClient(config.model, max_tokens=128).complete([
            {"role": "system", "content": '只输出一个合法 JSON 对象，不要 Markdown、说明或特殊标记。输出示例：{"ok":true}'},
            {"role": "user", "content": '请输出这个 JSON 对象：{"ok":true}'}
        ], config.model.timeout_seconds)
        record["usage"] = result.usage
        record.update(status="passed" if json.loads(result.text) == {"ok": True} else "failed")
    except Exception as exc:
        record.update(status="failed", error_type=type(exc).__name__)
        if isinstance(exc, AgentError):
            record["error"] = str(exc)
    record["latency_seconds"] = round(time.monotonic() - started, 3)
    config.runtime_dir.mkdir(parents=True, exist_ok=True)
    (config.runtime_dir / "connectivity.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "config.json")
    args = parser.parse_args()
    result = asyncio.run(probe(args.config))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
