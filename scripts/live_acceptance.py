"""Start an isolated vanilla server, apply admin fixtures, run native tests.

Administrative stdin is owned only by this harness, never exposed to the agent.
An already-running server is never killed or reused implicitly.
"""
from __future__ import annotations
import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import time
import hashlib
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]


def source_manifest():
    paths = list((ROOT / "src/sim_agent").rglob("*.py")) + list((ROOT / "executor/lib").rglob("*.js")) + list((ROOT / "scripts").glob("*.py"))
    paths += [ROOT / "executor/server.js", ROOT / "executor/package-lock.json", ROOT / "scripts/fixture_commands.txt"]
    return {str(p.relative_to(ROOT)).replace("\\", "/"): hashlib.sha256(p.read_bytes().replace(b"\r\n", b"\n")).hexdigest() for p in sorted(paths)}


async def run(args):
    started = time.time()
    source_before = source_manifest()
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    archive = ROOT / "runtime/acceptance" / run_id
    archive.mkdir(parents=True, exist_ok=True)
    status = "failed"
    server = ROOT / "runtime/server"
    if not (server / "server.jar").exists() or not (server / "eula.txt").exists():
        raise RuntimeError("Prepare the isolated lab with scripts/setup_lab.py first")
    config = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    mc = config["minecraft"]
    if mc["host"] != "127.0.0.1" or mc["port"] != 25575:
        raise RuntimeError("Live harness only targets its isolated 127.0.0.1:25575 lab")
    with socket.socket() as sock:
        if sock.connect_ex(("127.0.0.1", 25575)) == 0:
            raise RuntimeError("Port 25575 already in use; do not reuse an unknown server")
    java = args.java or shutil.which("java")
    if not java:
        hint = ROOT / "runtime/toolchain/java-path.txt"
        if hint.exists():
            java = hint.read_text(encoding="utf-8").strip()
    if not java:
        raise RuntimeError("Install Java 21 or pass --java")
    output = ROOT / "runtime/live-server.log"
    ready = asyncio.Event()
    proc = await asyncio.create_subprocess_exec(java, "-Xms512M", "-Xmx1536M", "-jar", "server.jar", "nogui",
        cwd=server, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)

    async def consume():
        with output.open("w", encoding="utf-8") as log:
            while line := await proc.stdout.readline():
                text = line.decode("utf-8", errors="replace")
                log.write(text)
                log.flush()
                if 'Done (' in text:
                    ready.set()
            if not ready.is_set():
                ready.set()

    reader = asyncio.create_task(consume())
    try:
        await asyncio.wait_for(ready.wait(), timeout=90)
        if proc.returncode is not None:
            raise RuntimeError(f"Server exited: see {output}")
        fixture = (ROOT / "scripts/fixture_commands.txt").read_text(encoding="utf-8")
        commands = [x for x in fixture.splitlines() if x.strip() and not x.startswith("#")]
        proc.stdin.write(("\n".join(commands) + "\n").encode("utf-8"))
        await proc.stdin.drain()
        await asyncio.sleep(1)
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONPATH"] = str(ROOT / "src")
        test = await asyncio.create_subprocess_exec(sys.executable, str(ROOT / "scripts/smoke_executor.py"), cwd=ROOT, env=env)
        code = await test.wait()
        if code:
            raise RuntimeError(f"Native acceptance failed ({code}); inspect runtime/executor-smoke.json")
        print("Live vanilla action acceptance passed", flush=True)
        tasks = await asyncio.create_subprocess_exec(sys.executable, str(ROOT / "scripts/live_tasks.py"), cwd=ROOT, env=env)
        code = await tasks.wait()
        if code:
            raise RuntimeError(f"Task acceptance failed ({code}); inspect runtime/task-evidence")
        chat = await asyncio.create_subprocess_exec(sys.executable, str(ROOT / "scripts/live_chat.py"), cwd=ROOT, env=env)
        code = await chat.wait()
        if code:
            raise RuntimeError(f"Chat acceptance failed ({code}); inspect runtime/chat-evidence")
        status = "passed"
    finally:
        if proc.returncode is None:
            proc.stdin.write(b"stop\n")
            await proc.stdin.drain()
            try:
                await asyncio.wait_for(proc.wait(), 30)
            except asyncio.TimeoutError:
                proc.terminate()
                await proc.wait()
        await reader
        for name in ["live-server.log", "executor-smoke.json", "live-task-results.json", "live-chat-results.json"]:
            path = ROOT / "runtime" / name
            if path.exists() and path.stat().st_mtime >= started:
                shutil.copy2(path, archive / name)
        after = source_manifest()
        unchanged = source_before == after
        (archive / "run.json").write_text(json.dumps({"run_id": run_id, "status": status if unchanged else "source_changed_during_run", "source_hash_format": "SHA-256 after normalizing text line endings to LF", "source_manifest": after}, indent=2), encoding="utf-8")
        if status == "passed" and not unchanged:
            raise RuntimeError("Source changed during acceptance; rerun a stable checkout")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--java")
    args = parser.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
