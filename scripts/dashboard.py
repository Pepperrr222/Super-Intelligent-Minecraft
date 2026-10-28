"""Source-tree entry point for the local planning dashboard."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from sim_agent.app.dashboard import main

if __name__ == "__main__":
    raise SystemExit(main())
