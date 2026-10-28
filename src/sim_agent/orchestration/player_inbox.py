"""Event-driven player supervision, independent from the one game body."""
import asyncio
import copy
import uuid

from sim_agent.domain.contracts import parse_proposal, text_value, refs
from sim_agent.domain.errors import ValidationError, OperationTimeout


class PlayerInbox:
    def __init__(self, service, team):
        self.service=service; self.team=team
        self.messages=asyncio.Queue(maxsize=32)
        self.waiting=[]
        self.job=None
        self.closed=False
        self.generation=0
        self.decision_job=None

    def submit(self, username, raw, command):
        if self.closed or self.messages.full(): return "queue_full"
        self.messages.put_nowait((username,raw,command,self.generation))
        if self.job is None or self.job.done():
            self.job=asyncio.create_task(self._pump(),name="player-coordinator-inbox")
        return "received"

    def invalidate(self):
        self.generation+=1
        self.waiting.clear()
        while not self.messages.empty(): self.messages.get_nowait()
        if self.decision_job and not self.decision_job.done(): self.decision_job.cancel()

    async def close(self):
        self.closed=True; self.invalidate()
        if self.job and not self.job.done():
            self.job.cancel(); await asyncio.gather(self.job,return_exceptions=True)

    async def _pump(self):
        while not self.closed and not self.messages.empty():
            username,raw,command,generation=self.messages.get_nowait()
            if generation!=self.generation: continue
            try:
                self.decision_job=asyncio.create_task(self._decide(username,raw,command,generation))
                await self.decision_job
            except asyncio.CancelledError:
                if self.closed: return
            except Exception as exc:
                self.service._logs.trace({"type":"player_message_failed","error_type":type(exc).__name__})
                await self.service._say("这条消息未能处理，当前任务未被自动替换。请重试或使用停止。",quiet=False)
            finally:
                self.decision_job=None
                self.start_next()

    async def _decide(self, username, raw, command, generation):
        s=self.service; runner=s._runner
        version=s._task_version
        active=s._current
        snap=copy.deepcopy(runner.snap) if runner.snap else None
        attempt=(runner.stage or {}).get("attempt_id")
        if runner.active and runner.budget:
            runner.budget.take("call")
            context=runner._context("coordinator","player_message")
        else:
            from sim_agent.agents.business_context import facts_only
            context={"purpose":"player_message","current_task":facts_only(snap),"evidence":[],
                     "observation":facts_only((snap or {}).get("state",{}).get("final_observation"))}
        context.update({"purpose":"player_message","incoming_message":{"requester":username,"raw_chat":raw,"text":command},
                        "task_running":s.busy,"queued_requests":[m[2] for m in self.waiting]})
        call_id="call-"+uuid.uuid4().hex
        task_id=(snap or {}).get("task_id","inbox-"+uuid.uuid4().hex)
        meta={"call_id":call_id,"task_id":task_id,"role":"coordinator","purpose":"player_message",
              "root_task_id":(snap or {}).get("root_task_id"),"task_version":version,
              "model":s._config.model.name,"provider":s._config.model.provider,"thinking":s._config.model.thinking,
              "step":runner.budget.calls if runner.active else 1,"stream":s._config.model.stream}
        s._logs.model_event({"type":"model_start",**meta})
        status="error"; usage={}; opened=True
        def observer(event):
            if opened and generation==self.generation and event.get("type")=="model_delta":
                s._logs.model_event({**event,"call_id":call_id})
        try:
            result=await runner._race(self.team.call("coordinator",context,s._config.model.timeout_seconds,observer),
                                     s._config.model.timeout_seconds,asyncio.Event(),OperationTimeout("消息调度超时"))
            usage=result.usage
            if self.closed or s._disconnected or generation!=self.generation or version!=s._task_version or active is not s._current:
                status="discarded"
                await s._say("任务状态已变化，这次调度结果已作废，请重新发送该指令。",quiet=False)
                return
            decision=parse_proposal(result.text,"coordinator",business=True,control=True)
            if decision["kind"]=="cancel_stage" and attempt!=(runner.stage or {}).get("attempt_id"):
                status="discarded"
                return
            if runner.active:
                runner.state.record_usage(step_index=runner.budget.calls,model=result.model,usage=usage,latency_ms=0,
                    model_call=getattr(self.team,"is_real_model",True))
            s._logs.trace({"type":"player_message_decision","task_id":task_id,"username":username,
                           "message":command,"decision":decision})
            await self._apply(decision,username,raw,command)
            status="completed"
        except asyncio.CancelledError:
            status="cancelled"; raise
        finally:
            opened=False
            if runner.active and "total_tokens" not in usage: runner.snap["usage_incomplete"]=True
            s._logs.model_event({"type":"model_end","call_id":call_id,"status":status,"usage":usage,
                                 "usage_incomplete":"total_tokens" not in usage})

    async def _apply(self, decision, username, raw, command):
        s=self.service; runner=s._runner
        kind=decision["kind"]; p=decision["payload"]
        if kind in {"reply","clarify"}:
            if kind=="reply":
                available=[e["id"] for e in (runner.snap or {}).get("evidence",[])]
                refs(p["evidence_refs"],"evidence_refs",available)
            from sim_agent.interaction.delivery import split_report
            for part in split_report(text_value(p["text"],"reply",500)):
                if not await s._say(part,quiet=False): break
        elif kind=="queue":
            if len(self.waiting)>=8: raise ValidationError("待执行任务队列已满")
            self.waiting.append((username,raw,command))
            s._logs.trace({"type":"task_queued","task_id":runner.task_id,"username":username,"message":command})
            await s._say("已加入待执行任务。",quiet=False)
            self.start_next()
        elif kind=="correct":
            if not s.busy: raise ValidationError("没有可纠正的运行任务")
            s._task_version+=1
            await s._correct_task(command,s._task_version,username,raw_chat=raw)
        elif kind in {"replace","pause","end"}:
            current=s._current
            if s.busy:
                s._task_version+=1
                if kind=="pause": await runner.interrupt("玩家暂停任务")
                else: await runner.cancel("玩家替换任务" if kind=="replace" else "玩家结束任务")
                if not runner.active: s._pending_stop=True
                if current: await asyncio.wait_for(asyncio.shield(current),8)
            if kind=="replace":
                if runner.snap and any(a.get("status") in {"unknown","submitting","acknowledged"}
                        for a in runner.store.actions(runner.snap["root_task_id"])):
                    raise ValidationError("旧动作结果未确认，保留中断任务，不能自动启动替换任务")
                for pending in runner.pending(): runner.discard_pending(pending["root_task_id"])
                s._launch_chat(command,username,raw)
            elif kind=="pause": await s._say("任务已暂停，已保留进度，可以继续。",quiet=False)
            else:
                for pending in runner.pending():
                    if any(a.get("status") in {"unknown","submitting","acknowledged"}
                            for a in runner.store.actions(pending["root_task_id"])):
                        raise ValidationError("结束请求已停止执行，但旧动作结果未确认，仍需人工核对")
                    runner.discard_pending(pending["root_task_id"])
                await s._say("任务已结束，不记为成功。",quiet=False)
        elif kind=="resume":
            pending=runner.pending()
            prior=next((x for x in pending if x["status"]=="interrupted"),None)
            if s.busy or prior is None: raise ValidationError("没有可恢复的暂停任务")
            s._task_version+=1; s._busy=True
            s._current=asyncio.create_task(s._resume_task(prior,username))
            s._current.add_done_callback(s._consume_task_result)
        elif kind=="cancel_stage":
            if not await runner.stop_stage(): raise ValidationError("当前没有正在执行的子任务")
            await s._say("正在停止当前子任务；确认停止后，最高层将根据已有进度重新决策。",quiet=False)

    def start_next(self):
        s=self.service
        if self.closed or s.busy or s._disconnected or s._runner.pending() or not self.messages.empty(): return
        if s._revision_task and not s._revision_task.done(): return
        # Do not start queued body work halfway through a pause/replacement decision.
        if self.decision_job and not self.decision_job.done(): return
        if self.waiting:
            username,raw,command=self.waiting.pop(0)
            s._launch_chat(command,username,raw)
