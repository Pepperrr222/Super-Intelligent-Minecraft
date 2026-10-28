"""Owned loopback-only Minecraft lab for cloud acceptance. Not an agent tool."""
from __future__ import annotations
import asyncio
from pathlib import Path
import shutil
import socket

ROOT = Path(__file__).resolve().parents[1]


class VanillaLab:
    def __init__(self, output: Path, java: str | None = None):
        self.output = output
        self.java = java
        self.proc = None
        self.reader = None

    async def __aenter__(self):
        server = ROOT / "runtime/server"
        props = dict(line.split("=", 1) for line in (server / "server.properties").read_text(encoding="utf-8").splitlines() if "=" in line and not line.startswith("#"))
        if props.get("server-ip") != "127.0.0.1" or props.get("server-port") != "25575":
            raise RuntimeError("Cloud acceptance requires the isolated loopback lab")
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", 25575)) == 0:
                raise RuntimeError("Lab port already occupied; refusing to reuse or terminate an unknown server")
        java = self.java or shutil.which("java")
        if not java:
            java = (ROOT / "runtime/toolchain/java-path.txt").read_text(encoding="utf-8").strip()
        self.output.mkdir(parents=True, exist_ok=True)
        self.proc = await asyncio.create_subprocess_exec(java, "-Xms512M", "-Xmx1536M", "-jar", "server.jar", "nogui", cwd=server,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        ready = asyncio.Event()
        async def read():
            with (self.output / "server.log").open("w", encoding="utf-8") as log:
                while line := await self.proc.stdout.readline():
                    text = line.decode("utf-8", errors="replace")
                    log.write(text)
                    log.flush()
                    if "Done (" in text:
                        ready.set()
                ready.set()
        self.reader = asyncio.create_task(read())
        try:
            await asyncio.wait_for(ready.wait(), 90)
            if self.proc.returncode is not None:
                raise RuntimeError("Lab server exited during startup; inspect local server.log")
        except BaseException:
            await self.__aexit__(None, None, None)
            raise
        return self

    async def commands(self, commands: list[str]):
        self.proc.stdin.write(("\n".join(commands) + "\n").encode("utf-8"))
        await self.proc.stdin.drain()
        await asyncio.sleep(0.3)

    async def reset_fixture(self):
        lines = (ROOT / "scripts/fixture_commands.txt").read_text(encoding="utf-8").splitlines()
        await self.commands([x for x in lines if x.strip() and not x.startswith("#")])
        await asyncio.sleep(0.7)

    async def __aexit__(self, *args):
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.stdin.write(b"stop\n")
                await self.proc.stdin.drain()
                await asyncio.wait_for(self.proc.wait(), 30)
            except (BrokenPipeError, ConnectionResetError, asyncio.TimeoutError):
                if self.proc.returncode is None:
                    self.proc.terminate()
                    await self.proc.wait()
        if self.reader:
            await self.reader
