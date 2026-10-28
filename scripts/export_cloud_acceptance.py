"""Export whitelisted cloud acceptance evidence; no credentials or raw config."""
from __future__ import annotations
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    paths = sorted((ROOT / "runtime/cloud-acceptance").glob("*/report.json"))
    if not paths:
        raise RuntimeError("Run cloud_acceptance.py first")
    latest = json.loads(paths[-1].read_text(encoding="utf-8"))
    if latest["status"] != "passed" or not latest["source_unchanged"] or latest["rules_fallback"]:
        raise RuntimeError("Latest stable cloud acceptance did not pass without rules fallback")
    history = []
    for path in paths:
        report = json.loads(path.read_text(encoding="utf-8"))
        history.append({"run_id": path.parent.name, "status": report["status"], "providers": [
            {"provider": p["provider"], "model": p["model"], "passed_cases": sum(c["passed"] for c in p["cases"]),
             "total_cases": len(p["cases"]), "failed_cases": [c["id"] for c in p["cases"] if not c["passed"]],
             "api_attempts": p["api_attempts"], "usage": p["usage"]}
            for p in report["providers"]]})
    allowed = {"provider", "model", "thinking", "mode", "cases", "status", "api_attempts", "api_errors", "usage", "usage_incomplete"}
    providers = [{k: v for k, v in p.items() if k in allowed} for p in latest["providers"]]
    date = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    summary = {
        "date_asia_shanghai": date, "status": "passed", "run_id": paths[-1].parent.name,
        "environment": latest["environment"], "cloud_llm_tested": True, "rules_fallback": False,
        "model_parameters_fixed": True, "learning_improvement_measured": False,
        "providers": providers,
        "source_manifest": latest["source_manifest"], "source_hash_format": latest["source_hash_format"],
        "development_history": history,
        "usage_scope": "Provider token usage covers returned responses in each listed task run; discovery, probes and separate manual diagnostics are excluded. Errors with unavailable usage are marked incomplete.",
        "limitations": ["Four controlled engineering cases per provider, not independent statistical trials", "Development runs use different code/prompt versions and are not model-quality comparisons", "No B1/B2/B3 learning-effect or modpack-compatibility claim"],
    }
    output = ROOT / "benchmarks/results" / f"cloud-{date}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
