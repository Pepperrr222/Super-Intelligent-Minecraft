"""Bounded chat delivery; receipts mean submitted, never read by a player."""
import asyncio
import re
import time
from sim_agent.domain.errors import ValidationError, TransportError


def split_report(text, limit=180, maximum=8):
    if not isinstance(text, str) or not text.strip(): raise ValidationError("报告为空")
    if any(ord(c)<32 and c not in '\n\r\t' for c in text): raise ValidationError("报告含控制字符")
    text = re.sub(r"\s+", " ", text).strip()
    if text.startswith("/"): raise ValidationError("报告不能是游戏命令")
    parts, part, units = [], "", 0
    for char in text:
        size = len(char.encode("utf-16-le"))//2
        if units + size > limit:
            parts.append(part); part=""; units=0
        part += char; units += size
    if part: parts.append(part)
    if len(parts)>maximum: raise ValidationError("报告超过8段，请压缩后重新提交")
    return [(f"({i+1}/{len(parts)}) " if len(parts)>1 else "")+s for i,s in enumerate(parts)]


class DeliveryService:
    def __init__(self, store, interval=1.2):
        self.store, self.interval = store, interval
        self.last_sent = 0.

    async def submit(self, report, send, check, emit):
        parts = split_report(report["text"])
        for i, text in enumerate(parts):
            status = self.store.part_status(report["id"], i)
            if status == "submitted": continue
            if status in {"submitting", "unknown"}:
                raise TransportError("报告分段提交结果未知，需显式确认补发，不能假定未发送")
            check()
            await asyncio.sleep(max(0,self.interval-(time.monotonic()-self.last_sent)))
            check()
            self.store.save_part(report["id"], i, "submitting", text)
            try:
                response = await send(text)
                if response.get("sent") is not True: raise TransportError("聊天未返回提交回执")
            except BaseException:
                self.store.save_part(report["id"], i, "unknown", text)
                emit("delivery_failed", {"report_id": report["id"], "part_index": i, "status": "unknown"})
                raise
            self.last_sent = time.monotonic()
            self.store.save_part(report["id"], i, "submitted", text)
            emit("delivery_submitted", {"report_id": report["id"], "part_index": i, "status": "submitted"})
        return "submitted"
