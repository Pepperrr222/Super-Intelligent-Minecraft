"""Run MC-01 on an owned vanilla 1.21.1 server."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"src"))
from sim_agent.evaluation.mc01.cli import main
if __name__ == "__main__": raise SystemExit(main())
