import argparse
import asyncio
from datetime import datetime
from pathlib import Path
from .setup import prepare,ASSETS,ROOT
from .runner import run_batch
from .smoke import smoke

def main(argv=None):
    parser=argparse.ArgumentParser(description="MC-01：10个原木、木斧和木镐，Java 1.21.1")
    sub=parser.add_subparsers(dest="command",required=True)
    setup=sub.add_parser("prepare",help="下载1.21.1服务端及可选录制mod")
    setup.add_argument("--record",action="store_true",help="同时安装Fabric和ServerReplay")
    setup.add_argument("--java",default="java")
    for command in ("run","smoke"):
        child=sub.add_parser(command,help="真实模型任务" if command=="run" else "零模型执行器联调")
        child.add_argument("--java",default="java");child.add_argument("--accept-eula",action="store_true")
        child.add_argument("--record",action="store_true",help="自动录制Agent，保存ReplayMod .mcpr录像")
        child.add_argument("--output",type=Path,default=ROOT/"runtime/mc01"/(command+"-"+datetime.now().strftime("%Y%m%d-%H%M%S")))
        if command=="run":
            child.add_argument("--config",type=Path,default=ROOT/"config.json")
            child.add_argument("--orchestration",choices=["legacy","hierarchical"],default="hierarchical")
            child.add_argument("--planner",choices=["llm","rules"],default="llm")
    args=parser.parse_args(argv)
    if args.command=="prepare":
        print(prepare())
        if args.record:
            from .recording import prepare_recording
            print(prepare_recording(args.java))
        return 0
    if not args.accept_eula:parser.error("同意 https://www.minecraft.net/eula 后加 --accept-eula")
    if not (ASSETS/"server.jar").exists():parser.error("请先执行prepare")
    if args.command=="smoke":return asyncio.run(smoke(args))
    if args.orchestration=="hierarchical" and args.planner=="rules":parser.error("rules使用--orchestration legacy")
    if not args.config.exists():parser.error("请用--config指定项目配置")
    args.tasks=["MC-01"]
    return asyncio.run(run_batch(args))
