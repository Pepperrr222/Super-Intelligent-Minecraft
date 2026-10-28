"""Root-owned budget; workers/revisions cannot reset spent resources."""
import time
from sim_agent.domain.errors import DeadlineExceeded


class Budget:
    def __init__(self, seconds, tools, calls, saved=None):
        self.limit_seconds, self.limit_tools, self.limit_calls = seconds, tools, calls
        self.used_seconds = (saved or {}).get("active_seconds", 0.)
        self.tools = (saved or {}).get("tools", 0)
        self.calls = (saved or {}).get("calls", 0)
        self.started = time.monotonic()

    @property
    def remaining(self):
        return self.limit_seconds - self.used_seconds - (time.monotonic() - self.started)

    def take(self, kind, reserve=0):
        if self.remaining <= 0: raise DeadlineExceeded("任务活动时间已耗尽")
        if kind == "call":
            if self.calls >= self.limit_calls: raise DeadlineExceeded("模型调用预算已耗尽")
            self.calls += 1
        else:
            if self.tools + reserve >= self.limit_tools: raise DeadlineExceeded("工具预算不足，保留验收开销")
            self.tools += 1

    def snapshot(self):
        return {"active_seconds": self.used_seconds + time.monotonic()-self.started,
                "tools": self.tools, "calls": self.calls,
                "remaining_seconds": max(0, self.remaining), "remaining_tools": max(0, self.limit_tools-self.tools),
                "remaining_calls": max(0,self.limit_calls-self.calls)}
