"""Publish a small reproducible summary, leaving raw runtime logs local."""
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    runs = sorted((ROOT / "runtime/acceptance").glob("*/run.json"))
    if not runs:
        raise RuntimeError("Run live_acceptance.py first")
    path = runs[-1]
    metadata = json.loads(path.read_text(encoding="utf-8"))
    if metadata["status"] != "passed":
        raise RuntimeError("Latest stable acceptance did not pass")
    directory = path.parent
    actions = json.loads((directory / "executor-smoke.json").read_text(encoding="utf-8"))
    tasks = json.loads((directory / "live-task-results.json").read_text(encoding="utf-8"))
    chat = json.loads((directory / "live-chat-results.json").read_text(encoding="utf-8"))
    if any(x["status"] != "passed" for x in [actions, tasks, chat]):
        raise RuntimeError("Incomplete evidence")
    date = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    server = json.loads((ROOT / "runtime/server/download.json").read_text(encoding="utf-8"))
    java = json.loads((ROOT / "runtime/toolchain/source.json").read_text(encoding="utf-8")) if (ROOT / "runtime/toolchain/source.json").exists() else None
    result = {
        "date_asia_shanghai": date, "status": "passed", "acceptance_run_id": metadata["run_id"],
        "environment": {"game": "Minecraft Java", "version": server["minecraft_version"], "server_sha1": server["sha1"], "java_source": java, "connection": "isolated loopback offline-auth server"},
        "planners": ["bounded Chinese rules baseline", "deterministic native-action scripts", "adversarial false-completion script"],
        "cloud_llm_tested": False, "learning_improvement_measured": False,
        "native_action_checks": actions["checks"], "task_checks": tasks["checks"], "chat_checks": chat["checks"],
        "stop_command_to_task_end_seconds": chat["stop_seconds"],
        "check_count": sum(len(x["checks"]) for x in [actions, tasks, chat]),
        "source_manifest": metadata["source_manifest"],
        "source_hash_format": metadata.get("source_hash_format", "raw bytes"),
        "limitations": ["Checks are not independent statistical trials", "No general LLM capability or B1/B2/B3 improvement is claimed", "No modpack compatibility acceptance"],
    }
    output = ROOT / "benchmarks/results" / f"vanilla-{date}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
