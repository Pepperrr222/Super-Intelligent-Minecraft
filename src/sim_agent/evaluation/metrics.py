"""Aggregate complete task records without treating chat messages as success."""
from __future__ import annotations
import argparse
import json
from collections import Counter
from pathlib import Path
from statistics import mean


def summarize(records: list[dict]) -> dict:
    tasks = [r for r in records if r.get("type") == "task_end"]
    ids = [r["task_id"] for r in tasks]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate task IDs: supply each trial once")
    states = Counter(r["end_state"] for r in tasks)
    verified = sum(r["end_state"] == "completed" and (r.get("verification") or {}).get("ok") is True for r in tasks)
    false_reports = sum(r["end_state"] == "completed" and (r.get("verification") or {}).get("ok") is not True for r in tasks)
    return {"trials": len(tasks), "verified_successes": verified,
            "success_rate": verified / len(tasks) if tasks else None,
            "unverified_completions": false_reports, "end_states": dict(states),
            "mean_duration_seconds": mean(r["duration_seconds"] for r in tasks) if tasks else None,
            "model_calls": sum(r.get("usage", {}).get("calls", 0) for r in tasks),
            "total_tokens": sum(r.get("usage", {}).get("total_tokens", 0) for r in tasks),
            "mutation_actions": sum(s.get("op") == "act" for r in tasks for s in r.get("steps", []))}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Summarize one mode/environment's tasks.jsonl")
    parser.add_argument("logs", nargs="+", type=Path)
    args = parser.parse_args(argv)
    records = [json.loads(line) for p in args.logs for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]
    print(json.dumps(summarize(records), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
