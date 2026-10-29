"""Disposable vanilla server and the first task's simple woodland scene."""
import asyncio
import json
from pathlib import Path
import secrets
import shutil
import socket
from .setup import ASSETS
from .rcon import Rcon,parse_snbt
from .recording import ReplayRecording,install_recording

ITEMS="wooden_axe wooden_pickaxe oak_log oak_planks stick crafting_table".split()
PUBLIC_SCENE=("初始事实：空背包，普通难度。橡树位于x=-20至-8,z=8至20，地面站立高度y=-60。"
    "空格(2,-60,0)下方有坚实地面，可放置自制工作台。")

def atomic_json(path,value):
    path=Path(path);temp=path.with_suffix(".tmp");temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding="utf-8");temp.replace(path)

def free_port():
    with socket.socket() as s:s.bind(("127.0.0.1",0));return s.getsockname()[1]

def fixture_commands(task_id="MC-01"):
    out=["gamerule doMobSpawning false","gamerule spawnRadius 0","time set 6000","weather clear","setworldspawn 0 -60 0",
         "fill -28 -60 -24 28 -54 24 air","fill -28 -61 -24 28 -61 24 grass_block"]
    for x in (-20,-16,-12,-8):
        for z in (8,12,16,20):out += [f"fill {x} -60 {z} {x} -57 {z} oak_log",f"setblock {x} -56 {z} oak_leaves[persistent=true]"]
    for i,item in enumerate(ITEMS):out.append(f"scoreboard objectives add bc{i} minecraft.crafted:minecraft.{item}")
    out += ["scoreboard objectives add bm minecraft.mined:minecraft.oak_log","scoreboard objectives add bp minecraft.picked_up:minecraft.oak_log","scoreboard objectives add bd deathCount"]
    return out

class OwnedServer:
    def __init__(self,folder,java="java",accept_eula=False,record=False):
        self.folder=Path(folder).resolve();self.java=java;self.accept_eula=accept_eula;self.port=free_port();self.rcon_port=free_port();self.password=secrets.token_hex(16)
        self.proc=None;self.reader=None;self.rcon=None
        self.recording=ReplayRecording(self) if record else None
    async def __aenter__(self):
        if not self.accept_eula:raise RuntimeError("Use --accept-eula after agreeing to https://www.minecraft.net/eula")
        self.folder.mkdir(parents=True,exist_ok=False);shutil.copy2(ASSETS/"server.jar",self.folder/"server.jar")
        if self.recording:install_recording(self.folder)
        (self.folder/"eula.txt").write_text("eula=true\n")
        properties=["server-ip=127.0.0.1",f"server-port={self.port}","online-mode=false","enforce-secure-profile=false","level-name=world","level-type=minecraft:flat",
            'generator-settings={"biome":"minecraft:plains","layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":2},{"block":"minecraft:grass_block","height":1}]}',
            "level-seed=104729","spawn-protection=0","difficulty=normal","gamemode=survival","max-players=2","view-distance=3","simulation-distance=3",
            "enable-rcon=true",f"rcon.port={self.rcon_port}",f"rcon.password={self.password}","broadcast-rcon-to-ops=false"]
        (self.folder/"server.properties").write_text("\n".join(properties),encoding="utf-8")
        ready=asyncio.Event()
        launch="fabric-server-launch.jar" if self.recording else "server.jar"
        self.proc=await asyncio.create_subprocess_exec(self.java,"-Xms512M","-Xmx1536M","-jar",launch,"nogui",cwd=self.folder,
            stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.STDOUT)
        async def read():
            with (self.folder/"server.log").open("w",encoding="utf-8") as f:
                while line:=await self.proc.stdout.readline():
                    text=line.decode("utf-8",errors="replace");f.write(text);f.flush()
                    if 'Done (' in text:ready.set()
                ready.set()
        self.reader=asyncio.create_task(read())
        try:
            await asyncio.wait_for(ready.wait(),120)
            if self.proc.returncode is not None:raise RuntimeError("Server startup failed: see server.log")
            self.rcon=await asyncio.to_thread(lambda:Rcon(self.rcon_port,self.password).connect())
        except BaseException:await self.__aexit__(None,None,None);raise
        return self
    async def command(self,text):return await asyncio.to_thread(self.rcon.command,text)
    async def start_recording(self,username):
        if self.recording:await self.recording.start(username)
    async def stop_recording(self):
        if self.recording:await self.recording.stop()
    async def commands(self,commands):
        for text in commands:await self.command(text)
    async def capture(self,username,episode_id):
        await self.command('data modify storage mc01:result value set value {inventory:{},crafted:{},mined:0,picked:0,deaths:0}')
        for i,item in enumerate(ITEMS):
            await self.command(f"execute store result storage mc01:result value.inventory.{item} int 1 run clear {username} minecraft:{item} 0")
            await self.command(f"execute store result storage mc01:result value.crafted.{item} int 1 run scoreboard players get {username} bc{i}")
        for key,obj in (("mined","bm"),("picked","bp"),("deaths","bd")):
            await self.command(f"execute store result storage mc01:result value.{key} int 1 run scoreboard players get {username} {obj}")
        raw=await self.command("data get storage mc01:result value")
        start=raw.find("{")
        if start<0:raise RuntimeError("Cannot read server result")
        state=parse_snbt(raw[start:]);state["inventory"]={"minecraft:"+k:v for k,v in state["inventory"].items()}
        state["crafted"]={"minecraft:"+k:v for k,v in state["crafted"].items()}
        state.update(episode_id=episode_id,game_version="1.21.1",natural_logs_collected=min(state["mined"],state["picked"]))
        return state
    async def __aexit__(self,*exc):
        if self.rcon:self.rcon.close()
        if self.proc and self.proc.returncode is None:
            try:self.proc.stdin.write(b"stop\n");await self.proc.stdin.drain();await asyncio.wait_for(self.proc.wait(),30)
            except (BrokenPipeError,ConnectionResetError,asyncio.TimeoutError):self.proc.kill();await self.proc.wait()
        if self.reader:await self.reader
        if self.recording:self.recording.save_manifest()
