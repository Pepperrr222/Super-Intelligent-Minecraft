"""Locate an explicitly configured Node runtime without changing system PATH."""
import os
import shutil

from sim_agent.domain.errors import TransportError


def resolve_node(configured: str | None = None) -> str:
    executable = configured or os.environ.get("SIM_NODE") or "node"
    resolved = shutil.which(executable)
    if resolved is None:
        raise TransportError(
            "找不到 Node.js 可执行文件。请安装 Node.js 22+ 并加入 PATH，"
            "或在配置顶层 node_executable 填写 node.exe 的完整路径（也可设置 SIM_NODE）。"
        )
    return resolved
