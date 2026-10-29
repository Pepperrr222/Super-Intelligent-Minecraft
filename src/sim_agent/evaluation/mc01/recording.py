"""Optional server-side ReplayMod recording; no game client or model needed."""
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import shutil
import subprocess
import urllib.request
import zipfile

from .setup import ASSETS

FABRIC = ASSETS / "recording"
LOADER = "0.16.14"
MODS = (
    ("ServerReplay-1.2.10+mc1.21.1.jar", "https://cdn.modrinth.com/data/qCvSZ8ra/versions/DsQNSbT9/ServerReplay-1.2.10%2Bmc1.21.1.jar", "c4a27a85c6c1352205c829f89d8cc3c64686d3c7"),
    ("fabric-api-0.116.17+1.21.1.jar", "https://cdn.modrinth.com/data/P7dR8mSH/versions/Mys3P7lK/fabric-api-0.116.17%2B1.21.1.jar", "810b2b0195371a012906241d8b85a32a1d6de53c"),
    ("fabric-language-kotlin-1.13.0+kotlin.2.1.0.jar", "https://cdn.modrinth.com/data/Ha28R6CL/versions/csX9r2wS/fabric-language-kotlin-1.13.0%2Bkotlin.2.1.0.jar", "e3d4ebcc5aef85967ba622f9631e0897cbcd4e2c"),
)


def download(path, url, sha1):
    if path.exists() and hashlib.sha1(path.read_bytes()).hexdigest() == sha1:
        return
    print(f"下载 {path.name}…", flush=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".download")
    with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as out:
        shutil.copyfileobj(response, out)
    if hashlib.sha1(temporary.read_bytes()).hexdigest() != sha1:
        raise RuntimeError(f"下载不完整：{path.name}，请重试prepare --record")
    temporary.replace(path)


def prepare_recording(java="java"):
    """Install the pinned Fabric loader and three published mods once in runtime/."""
    installer = FABRIC / "installer.jar"
    download(installer, "https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.3/fabric-installer-1.0.3.jar", "dd1dbed21b72ecbe140644de742a06dcaa71580f")
    if not (FABRIC / "fabric-server-launch.jar").exists():
        with (FABRIC / "install.log").open("w", encoding="utf-8") as log:
            subprocess.run([java, "-jar", str(installer), "server", "-mcversion", "1.21.1", "-loader", LOADER, "-dir", str(FABRIC)],
                           stdout=log, stderr=subprocess.STDOUT, check=True, timeout=300)
    for name, url, sha1 in MODS:
        download(FABRIC / "mods" / name, url, sha1)
    return {"loader": LOADER, "recorder": "ServerReplay 1.2.10+mc1.21.1", "assets": str(FABRIC)}


def install_recording(folder):
    if not (FABRIC / "fabric-server-launch.jar").exists() or not all((FABRIC / "mods" / name).exists() for name, _, _ in MODS):
        raise RuntimeError("请先运行prepare --record，安装录制mod")
    for name in ("fabric-server-launch.jar", "fabric-server-launcher.properties"):
        if (FABRIC / name).exists():
            shutil.copy2(FABRIC / name, folder / name)
    for name in ("libraries", "mods"):
        shutil.copytree(FABRIC / name, folder / name)
    config = folder / "config/ServerReplay/config.json"
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(json.dumps({"enabled": True, "world_name": "MC-01", "server_name": "Agent benchmark",
        "player_predicate": {"type": "none"}, "ignore_light_packets": False,
        "allow_downloading_replays": False, "notify_admins_of_status": False}), encoding="utf-8")


class ReplayRecording:
    def __init__(self, server):
        self.server = server
        self.username = None
        self.started_at = None
        self.stopped_at = None
        self.commands = []

    async def start(self, username):
        response = await self.server.command(f"replay start players {username}")
        self.commands.append(response)
        if "Successfully started 1 recordings" not in response:
            raise RuntimeError(f"录制启动失败：{response}")
        self.username = username
        self.started_at = datetime.now(timezone.utc).isoformat()
        # Let the initial login/chunk snapshot settle before the first game action.
        await asyncio.sleep(.5)

    async def stop(self):
        if self.username and not self.stopped_at:
            self.commands.append(await self.server.command(f"replay stop players {self.username}"))
            self.stopped_at = datetime.now(timezone.utc).isoformat()

    def save_manifest(self):
        """Called after clean server shutdown, when async replay compression has finished."""
        files = []
        for path in sorted((self.server.folder / "recordings").rglob("*.mcpr")):
            try:
                with zipfile.ZipFile(path) as archive:
                    metadata = json.loads(archive.read("metaData.json"))
                    packets = archive.getinfo("recording.tmcpr").file_size
                files.append({"path": path.relative_to(self.server.folder.parent).as_posix(),
                    "bytes": path.stat().st_size, "packet_bytes": packets, "metadata": metadata})
            except (OSError, ValueError, KeyError, zipfile.BadZipFile):
                continue
        manifest = {"status": "saved" if files and all(f["packet_bytes"] > 0 for f in files) else "missing",
            "format": "ReplayMod .mcpr (render to MP4 in a client)", "minecraft": "1.21.1",
            "recorder": "ServerReplay 1.2.10+mc1.21.1", "username": self.username,
            "started_at": self.started_at, "stopped_at": self.stopped_at, "commands": self.commands, "files": files}
        target = self.server.folder.parent / "recording.json"
        target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        if manifest["status"] == "saved":
            print(f"录像：{target.parent / files[0]['path']}", flush=True)
        else:
            print(f"录像未保存完整，请查看 {target}", flush=True)
        return manifest
