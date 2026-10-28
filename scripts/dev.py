"""Cross-platform source-tree entry point. Uses the invoking Python interpreter."""
from __future__ import annotations
import argparse
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description="Project development commands")
    parser.add_argument("command", choices=["check", "test", "demo", "run"])
    args, extra = parser.parse_known_args()
    os.chdir(ROOT)
    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT / "src") + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    if args.command in {"check", "test"}:
        sys.path.insert(0, str(ROOT / "src"))
        from sim_agent.app.config import load_config
        from sim_agent.adapters.node_runtime import resolve_node
        from sim_agent.domain.errors import AgentError
        try:
            config = load_config(ROOT / ("config.json" if (ROOT / "config.json").exists() else "config.example.json"))
            node = resolve_node(config.node_executable)
        except AgentError as exc:
            print(str(exc), file=sys.stderr)
            return 1
    if args.command == "check":
        print(f"Python: {sys.version.split()[0]}")
        if sys.version_info < (3, 12):
            print("Python 3.12+ required")
            return 1
        version = subprocess.check_output([node, "--version"], text=True).strip()
        print(f"Node: {version}")
        if int(version.lstrip("v").split(".")[0]) < 22:
            return 1
        installed = (ROOT / "executor/node_modules/mineflayer").exists()
        print("Mineflayer: " + ("installed" if installed else "missing; run npm ci --prefix executor"))
        print("Config: " + ("config.json" if (ROOT / "config.json").exists() else "copy config.example.json and edit before live run"))
        return 0 if installed else 1
    if args.command == "test":
        if extra:
            parser.error("test takes no extra arguments")
        py = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"], env=env)
        tests = sorted(str(p.relative_to(ROOT)) for p in (ROOT / "executor/test").glob("*.test.js"))
        js = subprocess.run([node, "--test", *tests], env=env)
        return 0 if py.returncode == js.returncode == 0 else 1
    module = "sim_agent.app.demo" if args.command == "demo" else "sim_agent"
    return subprocess.call([sys.executable, "-m", module, *extra], env=env)


if __name__ == "__main__":
    raise SystemExit(main())
