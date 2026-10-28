"""Conservative detection of deictic references without supplied bindings.

Nearby objects alone do not identify which object the user meant. This guard
asks the planner to clarify; it does not choose targets or generate actions.
"""
import re

_COORD = re.compile(r"-?\d+(?:\.\d+)?\s*[,，\s]\s*-?\d+(?:\.\d+)?\s*[,，\s]\s*-?\d+(?:\.\d+)?")
_CONTAINER = re.compile(r"(?:这个|那个|这边的?|那边的?)(?:箱子|容器)")
_ITEMS = re.compile(r"(?:这些|那些)(?:东西|物品|材料)")


def unresolved_reference(text: str) -> str | None:
    missing = []
    if _CONTAINER.search(text) and not _COORD.search(text):
        missing.append("目标容器坐标或明确对象标识")
    if _ITEMS.search(text) and not re.search(r"minecraft:[a-z0-9_]+", text):
        missing.append("具体物品与数量")
    if not missing:
        return None
    return "玩家指代尚未绑定：请先澄清" + "、".join(missing) + "。不能猜测物品、数量或箱子坐标，也不能先执行或移动。"
