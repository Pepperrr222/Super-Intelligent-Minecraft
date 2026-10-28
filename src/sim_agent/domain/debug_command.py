"""Complete, deterministic single-action grammar. No model or I/O."""
import re
from dataclasses import dataclass
from sim_agent.domain.errors import ValidationError
from sim_agent.domain.validation import validate_step, ToolCall
from sim_agent.domain.goals import parse_goal, Goal

USAGE="动作调试仅支持：collect oak_log 4 / 采集4个橡木原木 / goto 10 -60 5 / 停止。复合任务与额外约束请使用Agent模式。"
LOGS=dict(zip(('橡木原木','白桦原木','云杉原木','丛林原木','金合欢原木','深色橡木原木','红树原木','樱花原木'),
              ('oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log')))

@dataclass(frozen=True)
class DebugCommand:
    call: ToolCall | None
    goal: Goal | None


def parse_debug_command(text):
    if not isinstance(text,str) or not 1<=len(text)<=500: raise ValidationError(USAGE)
    text=text.strip()
    if text.casefold() in {'stop','cancel','停止','停止任务','取消'}: return DebugCommand(None,None)
    collect=re.fullmatch(r'collect\s+(\S+)\s+([0-9]+)',text,re.I)
    chinese=re.fullmatch(r'(?:采集|收集)\s*([0-9]+)\s*[个根块]?\s*([^\s，。；]+)',text)
    if collect or chinese:
        name,count=(collect[1],collect[2]) if collect else (chinese[2],chinese[1])
        name=LOGS.get(name,name.removeprefix('minecraft:'))
        if name not in LOGS.values(): raise ValidationError("第一版只支持明确树种的原木，不能把石头等方块数量当成物品增量。"+USAGE)
        if len(count)>3: raise ValidationError("采集数量必须为1..64")
        call=validate_step({'op':'act','args':{'kind':'collect','block':'minecraft:'+name,'count':int(count)}})
        goal=parse_goal({'type':'inventory_increase','item':'minecraft:'+name,'count':int(count)})
        return DebugCommand(call,goal)
    coordinate=r'(-?\d+(?:\.\d+)?)'
    travel=re.fullmatch(r'(?:goto|去坐标|前往坐标)\s*'+r'\s+'.join([coordinate]*3),text,re.I)
    if travel:
        call=validate_step({'op':'act','args':{'kind':'goto','position':dict(zip(('x','y','z'),map(float,travel.groups()))),'range':2}})
        return DebugCommand(call,parse_goal({'type':'near_position','position':call.args['position'],'range':2}))
    raise ValidationError(USAGE)
