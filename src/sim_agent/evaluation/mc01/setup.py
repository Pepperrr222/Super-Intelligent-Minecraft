"""Download only the vanilla 1.21.1 server. No Gradle, Fabric or model calls."""
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request
ROOT=Path(__file__).resolve().parents[4]
BENCH=ROOT/"benchmarks/mc01"
ASSETS=ROOT/"runtime/mc01-assets"

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def prepare(java="java"):
    ASSETS.mkdir(parents=True,exist_ok=True);target=ASSETS/"server.jar"
    if not target.exists() or target.stat().st_size!=51627615:
        url="https://piston-data.mojang.com/v1/objects/59353fb40c36d304f2035d51e7d6e6baa98dc05c/server.jar"
        print("下载Minecraft 1.21.1服务端…",flush=True)
        # Resume an interrupted local download. A single final hash prevents using a damaged jar.
        start=target.stat().st_size if target.exists() else 0
        request=urllib.request.Request(url,headers={"Range":f"bytes={start}-"} if start else {})
        with urllib.request.urlopen(request,timeout=120) as response:
            mode="ab" if start and response.status==206 else "wb"
            with target.open(mode) as f:shutil.copyfileobj(response,f)
    if hashlib.sha1(target.read_bytes()).hexdigest()!="59353fb40c36d304f2035d51e7d6e6baa98dc05c":
        raise RuntimeError("服务端下载不完整；移走runtime/mc01-assets/server.jar后重试prepare")
    return {"minecraft":"1.21.1","server":str(target)}
