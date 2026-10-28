"""Hierarchical orchestration over the same guarded vanilla controller.

The model proposes; this runtime owns versions, facts, budgets and completion.
State is persisted before external side effects. Unknown outcomes never replay.
"""
from __future__ import annotations
import asyncio
import copy
import json
import time
import uuid

from sim_agent.domain.contracts import (TaskContract, parse_stages, parse_proposal, parse_checks, object_value,
                                        text_value, list_value, refs)
from sim_agent.domain.constraints import explicit_constraints, check_inventory, merge_constraints
from sim_agent.domain.errors import (AgentError, ValidationError, TaskCancelled, DeadlineExceeded,
                                     TransportError, OperationTimeout, ModelError)
from sim_agent.domain.goals import parse_goal, goal_leaves, container_key
from sim_agent.domain.lifecycle import transition, TERMINAL
from sim_agent.domain.references import unresolved_reference
from sim_agent.domain.state import TaskState, StepRecord, Observation
from sim_agent.domain.validation import validate_step, canonical_json
from sim_agent.execution.controller import ExecutionController
from sim_agent.execution.runner import TaskOutcome
from sim_agent.orchestration.budget import Budget
from sim_agent.capabilities.vanilla import CAPABILITIES, READ_ONLY
from sim_agent.persistence.task_store import TaskStore
from sim_agent.interaction.delivery import DeliveryService
from sim_agent.verification.service import VerificationService, parse_report
from sim_agent.observability.jsonl import utc_now
from sim_agent.agents.business_context import coordinator_context


def uid(prefix): return prefix + "-" + uuid.uuid4().hex


class RuntimeHalt(Exception):
    def __init__(self, status, message): self.status, self.message = status, message


class TaskRuntime(ExecutionController):
    def __init__(self, backend, team, config, logs=None, *, notify=None, store=None):
        if config.learning.mode != "B0": raise ValidationError("两层原版模式只支持B0")
        super().__init__(backend,config,logs,notify=notify)
        self.team = team
        self.store = store or TaskStore(config.runtime_dir / "tasks.sqlite3")
        self.store.mark_interrupted()
        self.delivery = DeliveryService(self.store)
        self.delivery_channel="game_chat"
        self.terminal_emit=None
        self.session_id = uid("executor")
        self.snap = None
        self.state = None
        self.stage = None
        self.budget = None
        self._body_lock = asyncio.Lock()
        self._journal = None
        self._cleanup = False
        self._finalizing = False
        self._stage_clock = None
        self._interrupted = False
        self._worker_job=None
        self._stage_stop_requested=False

    @property
    def active(self): return self._active

    @property
    def task_id(self): return self._task_id

    async def interrupt(self,reason):
        if self._cancel_event is None or not self._cancel_event.is_set(): self._interrupted=True
        return await self.cancel(reason)

    async def stop_stage(self):
        job=self._worker_job
        if not self.active or job is None or job.done(): return False
        self._stage_stop_requested=True
        job.cancel()
        return True

    def pending(self):
        return [s for s in self.store.recent() if s["status"] in {"waiting_input", "interrupted"}]

    def discard_pending(self, root_id):
        saved=self.store.read_task(root_id)
        if saved["status"] not in {"waiting_input","interrupted"}: raise ValidationError("任务不是暂停态")
        saved["status"]="cancelled"
        self.store.commit_transition(saved["revision"],{"type":"task_cancelled","ts":utc_now()},saved)

    def check(self):
        if self._cancel_event and self._cancel_event.is_set(): raise TaskCancelled(self._cancel_reason)
        if self.budget and self.budget.remaining <= 0: raise DeadlineExceeded("活动时间已耗尽")
        if self.stage and self._stage_clock is not None:
            if time.monotonic()-self._stage_clock + self.stage.get("spent_seconds",0) >= self.stage.get("budget",{}).get("timeout_seconds",3600):
                raise ValidationError("阶段活动时间已耗尽，应向上层升级")

    def _stage_take(self, key):
        if self.stage:
            spent=self.stage.setdefault("spent",{})
            limit_name="max_model_calls" if key=="calls" else "max_tools"
            limit=self.stage.get("budget",{}).get(limit_name,100)
            if spent.get(key,0)>=limit: raise ValidationError("阶段预算已耗尽："+key)
            spent[key]=spent.get(key,0)+1

    def _save(self, event_type, payload=None):
        if self.snap is None: return
        self.snap["state"] = self.state.to_dict() if self.state else None
        self.snap["budget"] = self.budget.snapshot() if self.budget else self.snap.get("budget", {})
        event = {"schema_version":"task-event.v1", "event_id":uid("event"), "ts":utc_now(),
                 "root_task_id":self.snap["root_task_id"], "task_id":self._task_id,
                 "task_version":self.snap["task_version"], "plan_revision":self.snap["plan_revision"],
                 "stage_id":self.stage["id"] if self.stage else None,
                 "attempt_id":self.stage.get("attempt_id") if self.stage else None,
                 "type":event_type, **(payload or {})}
        event["budget"] = self.snap["budget"]
        event["execution_environment"]=getattr(self.team,"environment","VANILLA_RUNTIME")
        if event_type in {"task_start","contract_accepted","plan_revised","stage_verified","stage_updated","task_end","report_created"}:
            event["view"]={k:self.snap.get(k) for k in ("request","contract","stages","report","delivery_status","work_status","status")}
        revision, seq = self.store.commit_transition(self.snap.get("revision",0),event,self.snap)
        self.snap["revision"] = revision
        event["sequence"] = seq
        self._logs.trace(event)

    def _usage(self):
        usage=self.state.usage_summary()
        usage["planning_calls"]=self.budget.calls
        usage["model_calls"]=self.budget.calls if getattr(self.team,"is_real_model",True) else 0
        usage["usage_incomplete"]=bool(self.snap.get("usage_incomplete"))
        usage["failed_or_unreported_calls"]=max(0,self.budget.calls-len(self.state.usage))
        return usage

    def _status(self, target):
        self.snap["status"] = transition(self.snap["status"],target)
        self._save("state_changed", {"status":target})

    def _evidence(self, kind, payload, origin=None, stage_id=None):
        e = {"id":uid("evidence"), "kind":kind, "world_id":self.state.world_id,
             "executor_session_id":self.session_id, "observed_at":payload.get("observed_at",utc_now()),
             "received_at":utc_now(), "stage_id":stage_id or (self.stage["id"] if self.stage else None),
             "payload":copy.deepcopy(payload), "origin":origin}
        comparable={k:v for k,v in payload.items() if k not in {"observed_at","received_at"}}
        fingerprint=kind+canonical_json(comparable)
        e["novel"]=fingerprint not in self.snap.setdefault("fact_fingerprints",[])
        if e["novel"]: self.snap["fact_fingerprints"].append(fingerprint)
        self.snap["evidence"].append(e)
        self._save("evidence_recorded", {"evidence":e})
        return e

    async def _request(self, op, args, deadline, cancel_event, *, timeout=None):
        journal = None
        if not self._cleanup:
            self.check()
            if op not in {"action_status", "stop"}:
                self._stage_take("tools")
                self.budget.take("tool", reserve=0 if self._finalizing or op in {"observe", "inspect_container", "say"} else 2)
                self._save("tool_submitting", {"op":op,"args":args})
            if op in {"act", "inspect_container"}:
                journal = self.store.journal(self.snap["root_task_id"],self.session_id,
                    {"status":"submitting","op":op,"args":args,"task_id":self._task_id,
                     "stage_id":self.stage["id"] if self.stage else None})
                self._journal = journal
        try:
            response = await super()._request(op,args,deadline,cancel_event,timeout=timeout)
        except BaseException:
            if journal:
                self.store.journal(self.snap["root_task_id"],self.session_id,
                    {"status":"unknown","op":op,"args":args},journal)
            raise
        if journal:
            record = {"status":"acknowledged" if "action_id" in response else "settled", "op":op,"args":args,
                      "action_id":response.get("action_id"), "result":response,
                      "stage_id":self.stage["id"] if self.stage else None,"task_id":self._task_id}
            self.store.journal(self.snap["root_task_id"],self.session_id,record,journal)
        if op == "observe":
            self.state.apply_observation(response)
            check_inventory(self.state.constraints, self.state.observation.raw)
            self._evidence("observe",response)
            self._logs.trace({"type":"observation","task_id":self._task_id,"observation":response})
        elif op in {"find_blocks", "recipes", "inspect_container"} and "action_id" not in response:
            self.state.check_world(response.get("world_id"))
            self._evidence(op,{**response,"args":args})
        elif op == "action_status" and response.get("status") in {"succeeded","failed","cancelled"}:
            for a in self.store.actions(self.snap["root_task_id"]):
                if a.get("session_id") == self.session_id and a.get("action_id") == args["action_id"]:
                    uncertain=(response.get("effect") or {}).get("effect_unknown") is True
                    self.store.journal(self.snap["root_task_id"],self.session_id,
                        {**a,"status":"unknown" if uncertain else "settled","result":response},a["id"])
        return response

    def _context(self, role, purpose):
        evidence = self.snap["evidence"]
        # Keep all source/constraint/baseline information; bound old bulky results.
        visible = evidence[-32:]
        for e in evidence:
            if e["id"] in self.snap.get("pinned_evidence",[]) and e not in visible: visible.append(e)
        ctx = {"original_request":self.snap["request"], "contract":self.snap.get("contract"),
               "task_version":self.snap["task_version"], "plan_revision":self.snap["plan_revision"],
               "plan":self.snap["stages"], "stage":self.stage if role=="worker" else None,
               "evidence":visible, "observation":self.state.observation.raw if self.state.observation else None,
               "facts":self.state.facts, "constraints":self.state.constraints,
               "root_baselines":{"inventory":self.state.start_inventory,"containers":self.state.container_baselines},
               "progress":self.snap["progress"][-16:], "budget":self.budget.snapshot(),
               "capabilities":self.snap.get("capabilities",{}), "purpose":purpose,
               "previous_error":self.snap.get("last_error"), "report":self.snap.get("report")}
        ctx["delivery_channel"]=self.delivery_channel
        ctx["verification_status"]={"root_ready":bool(self.snap.get("contract") and TaskContract(self.snap["contract"]).checks_ready),
                                    "stage_ready":bool(self.stage and self.stage.get("acceptance_checks"))}
        if self.snap.get("last_invalid_output") and self.snap.get("last_invalid_role")==role:
            ctx["previous_invalid_decision_for_repair"] = self.snap["last_invalid_output"][:12000]
        ctx["settled_actions"]=[{k:a.get(k) for k in ("action_id","op","args","result","status","stage_id")}
                                  for a in self.store.actions(self.snap["root_task_id"])[-24:]]
        latest_raw = next((e["payload"] for e in reversed(evidence) if e["kind"]=="observe"),None)
        if latest_raw is not None: ctx["observation"]=latest_raw
        if len(json.dumps(ctx,ensure_ascii=False))>110_000:
            raise DeadlineExceeded("上下文超出有界窗口；保留需求约束，停止而非截断")
        if role == "coordinator" and getattr(self.team,"protocol_version",None)=="business.v2":
            return coordinator_context(ctx)
        return ctx

    async def _model(self, role, purpose, extra=None):
        for attempt in range(2):
            try:
                return await self._model_once(role,purpose,extra)
            except (ModelError,OperationTimeout) as e:
                if self.budget.remaining<=0: raise DeadlineExceeded("模型等待期间任务时间耗尽") from e
                if attempt: raise
                self._save("model_retry",{"role":role,"error_type":type(e).__name__})

    async def _model_once(self, role, purpose, extra=None):
        self.check(); self._stage_take("calls"); self.budget.take("call")
        self.snap["inflight_model_seconds"]=max(0,min(self._config.model.timeout_seconds,self.budget.remaining))
        call_id=uid("call"); version=self.snap["task_version"]; task_id=self._task_id
        meta={"call_id":call_id,"task_id":task_id,"root_task_id":self.snap["root_task_id"],
              "task_version":version,"plan_revision":self.snap["plan_revision"],"role":role,"purpose":purpose,
              "stage_id":self.stage["id"] if self.stage else None,"step":self.budget.calls,
              "model":getattr(self.team,"model_name",self._config.model.name),"provider":self._config.model.provider,
              "thinking":self._config.model.thinking,"stream":self._config.model.stream}
        self._save("planning", {"role":role,"call_id":call_id,"step":self.budget.calls,
                                "remaining_seconds":round(self.budget.remaining,1)})
        self._logs.model_event({"type":"model_start",**meta})
        opened=True; usage={}; end="error"
        def observer(event):
            if opened and event.get("type")=="model_delta":
                self._logs.model_event({**event,"call_id":call_id})
        try:
            context=self._context(role,purpose)
            if extra: context.update(extra)
            result=await self._race(self.team.call(role,context,min(self._config.model.timeout_seconds,self.budget.remaining),observer),
                min(self._config.model.timeout_seconds,self.budget.remaining),self._cancel_event,OperationTimeout("模型调用超时"))
            self.check()
            if version!=self.snap["task_version"] or task_id!=self._task_id: raise TaskCancelled("过期模型输出")
            usage=result.usage
            self.snap["inflight_model_seconds"]=0
            self.state.record_usage(step_index=meta["step"],model=result.model,usage=usage,latency_ms=0,
                                    model_call=getattr(self.team,"is_real_model",True))
            end="completed"
            self._save("model_completed", {"role":role,"call_id":call_id,"usage":usage,"model":result.model,
                                          "model_call":getattr(self.team,"is_real_model",True)})
            return result.text
        except (TaskCancelled,asyncio.CancelledError): end="cancelled"; raise
        except OperationTimeout: end="timed_out"; raise
        except Exception as e: end=getattr(e,"status","error"); raise
        finally:
            opened=False
            self.snap["inflight_model_seconds"]=0
            if "total_tokens" not in usage and getattr(self.team,"is_real_model",True): self.snap["usage_incomplete"]=True
            self._logs.model_event({"type":"model_end","call_id":call_id,"status":end,"usage":usage,
                                   "usage_incomplete":not bool(usage)})

    async def _accept_contract(self, raw):
        if self.snap.get("contract") is not None: raise ValidationError("约定已接受，需用户纠正才能改变需求")
        source=[self.snap["request"]["command_text"]]+[a["text"] for a in self.snap["request"]["amendments"]]
        revisions=self.snap["request"]["amendments"]
        c=TaskContract.parse(raw,source,self.state.constraints,
            user_revision=bool(revisions and revisions[-1]["type"]=="correction"))
        if any(check["kind"]=="delivery_submission" and check["channel"]!=self.delivery_channel for check in c.checks):
            raise ValidationError("报告交付channel必须匹配当前入口："+self.delivery_channel)
        if unresolved_reference(source[0]) and not self.snap["request"]["amendments"]:
            raise ValidationError("未绑定指代，请先澄清，不得猜箱子位置")
        check_inventory(c.data["constraints"],self.state.observation.raw)
        self.state.constraints=c.data["constraints"]
        self.snap["contract"]=c.to_dict(); self.snap["contract_revision"]+=1
        self._save("contract_accepted", {"contract":c.to_dict(),"constraints":self.state.constraints})
        self._status("planning")

    async def _baselines(self, checks, target_state):
        for check in checks:
            if check["kind"]!="state_predicate": continue
            for leaf in goal_leaves(parse_goal(check["goal"])):
                if leaf.type!="container_delta": continue
                key=container_key(leaf.spec["position"])
                if key not in target_state.container_baselines:
                    if self.snap.get("mutations_started") and target_state is self.state:
                        raise ValidationError("动作后不能补造根容器增量基线")
                    self._bind_position(leaf.spec["position"])
                    call=validate_step({"op":"inspect_container","args":{"position":leaf.spec["position"]}})
                    result=await self._execute(call,target_state,self.deadline,self._cancel_event)
                    target_state.container_baselines[key]=result.result["container"]
        self._save("baselines_captured")

    def _bind_position(self, pos):
        # Only explicit request coordinates or an accepted explicit binding authorize a container.
        source=" ".join([self.snap["request"]["command_text"]]+[a["text"] for a in self.snap["request"]["amendments"]])
        import re
        numbers=[float(n) for n in re.findall(r"-?\d+(?:\.\d+)?",source)]
        xyz=[float(pos[a]) for a in ("x","y","z")]
        if any(numbers[i:i+3]==xyz for i in range(max(0,len(numbers)-2))): return
        for b in (self.snap.get("contract") or {}).get("bindings",[]):
            if b.get("resolution_status")=="explicit" and b.get("value")==pos:
                # A binding cannot become permission merely because the model labels it explicit.
                if any(all(str(pos[a]) in r or str(int(pos[a])) in r for a in ("x","y","z")) for r in b["source_refs"]): return
        raise ValidationError("容器坐标没有玩家原文的明确绑定，请澄清")

    async def _verify(self, checks, scoped_state, *, root=False, report=None):
        service=VerificationService()
        result,outcomes=await service.verify(checks,root_state=self.state,scoped_state=scoped_state,
            evidence=self.snap["evidence"],stage_id=self.stage["id"] if self.stage else None,
            input_evidence_ids=self.stage.get("input_evidence_ids",[]) if self.stage else [],
            stage=self.stage,
            root=root,report=report,report_verified=self.snap.get("report_verified"),
            delivery_status=self.snap.get("delivery_status"),delivery_channel=self.delivery_channel,
            contract=self.snap["contract"],
            verify_live=lambda goal,state:self._verify_live(goal,state,self.deadline,self._cancel_event),
            )
        self._save("verification",{"verification":{"ok":result,"checks":outcomes}})
        return result,outcomes

    async def _tool(self, proposal):
        p=proposal["payload"]; kind=proposal["kind"]
        if not isinstance(p["args"],dict) or "kind" in p["args"]:
            raise ValidationError("args必须是对象，动作kind放在payload.kind")
        op="act" if kind=="act" else p["op"]
        args={"kind":p["kind"],**p["args"]} if kind=="act" else p["args"]
        capability=args["kind"] if op=="act" else op
        if capability not in self.stage["allowed_capabilities"]: raise ValidationError("阶段未授权该能力")
        if "position" in args and (op=="inspect_container" or args.get("kind") in {"deposit","withdraw","smelt"}):
            self._bind_position(args["position"])
        call=validate_step({"op":op,"args":args})
        if op=="act":
            contract=TaskContract(self.snap["contract"])
            if not contract.checks_ready or not self.stage["acceptance_checks"]:
                raise ValidationError("先由Worker编译根交付和阶段完成标准，再执行动作")
            checks=contract.checks
            await self._baselines(checks,self.state)
            self.snap["mutations_started"]=True
            self._save("mutation_authorized")
        async with self._body_lock:
            result=await self._execute(call,self.state,self.deadline,self._cancel_event)
        self.state.add_step(StepRecord(index=len(self.state.steps)+1,op=op,args=call.args,status=result.status,
            started_at=utc_now(),finished_at=utc_now(),result=result.result,evidence=result.evidence,
            action_id=result.action_id,error=result.error))
        if op=="act": self._evidence("action",{"args":call.args,"status":result.status,"result":result.result,"evidence":result.evidence},result.action_id)
        self._save("result", {"op":op,"args":call.args,"status":result.status,"error":result.error})
        if result.status!="succeeded": raise ValidationError(result.error or "动作未成功")

    async def _prepare_verification(self, payload, scoped):
        """Worker compiles business criteria once, before effects; it cannot edit intent."""
        contract=TaskContract(self.snap["contract"]) if self.snap.get("contract") else None
        drafts=list_value(payload["deliverables"],"deliverables",maximum=16)
        stage_checks=list_value(payload["stage_checks"],"stage_checks",maximum=16)
        if contract is None and drafts: raise ValidationError("调查阶段不能自行建立根任务约定")
        compiled={}
        ids=contract.requirement_ids if contract else set()
        for draft in drafts:
            object_value(draft,"verification deliverable",{"id","acceptance_checks"})
            if draft["id"] in compiled: raise ValidationError("交付验收ID重复")
            checks=parse_checks(draft["acceptance_checks"],ids)
            if any(c.get("scope")=="stage" for c in checks): raise ValidationError("根交付不能使用阶段基线")
            compiled[draft["id"]]=checks
        if contract and contract.checks_ready and drafts:
            existing={d["id"]:d["acceptance_checks"] for d in contract.data["deliverables"]}
            if compiled!=existing: raise ValidationError("根验收已冻结，不可替换")
            compiled={}
        if contract and not contract.checks_ready:
            if self.snap.get("mutations_started"): raise ValidationError("动作之后不可补造根验收")
            if set(compiled)!={d["id"] for d in contract.data["deliverables"]}:
                raise ValidationError("必须编译全部根交付，不可遗漏需求")
        if stage_checks:
            stage_checks=parse_checks(stage_checks,ids)
            if self.stage["acceptance_checks"]:
                if stage_checks!=self.stage["acceptance_checks"]: raise ValidationError("阶段验收已冻结，不可替换")
                stage_checks=[]
            if any(c["kind"] in {"grounded_report","delivery_submission"} for c in stage_checks):
                raise ValidationError("Worker阶段不能以聊天代替结果")
        elif not self.stage.get("information_only") and not self.stage["acceptance_checks"]:
            raise ValidationError("阶段验收不能为空")
        all_checks=[c for checks in compiled.values() for c in checks]+stage_checks
        if any(c["kind"]=="semantic_review" for c in all_checks):
            raise ValidationError("独立Reviewer已移除，请使用实际状态或证据检查；无法验证则返回blocked")
        if any(c["kind"]=="delivery_submission" and c["channel"]!=self.delivery_channel for c in all_checks):
            raise ValidationError("报告回复渠道不匹配")
        for checks in compiled.values(): await self._baselines(checks,self.state)
        await self._baselines([c for c in stage_checks if c.get("scope")=="stage"],scoped)
        if compiled:
            for d in self.snap["contract"]["deliverables"]: d["acceptance_checks"]=compiled[d["id"]]
        if stage_checks: self.stage["acceptance_checks"]=stage_checks
        self.stage["saved_baselines"]={"inventory":scoped.start_inventory,"containers":scoped.container_baselines}
        self._save("verification_prepared",{"stage":self.stage,"deliverable_ids":list(compiled)})

    async def _worker(self, stage):
        try:
            self._stage_stop_requested=False
            self._worker_job=asyncio.create_task(self._run_worker(stage),name="stage-worker")
            await self._worker_job
        except asyncio.CancelledError:
            if not self._stage_stop_requested or self._cancel_event.is_set(): raise
            self._cleanup=True
            try:
                await self._stop_once()
                await self._capture_interrupted_action(self.state)
                for record in self.store.actions(self.snap["root_task_id"]):
                    if record.get("status") in {"acknowledged","submitting","unknown"}:
                        if not record.get("action_id"): raise RuntimeHalt("interrupted","子任务停止后动作结果未知，请核对后恢复")
                        result=await self._request("action_status",{"action_id":record["action_id"]},self.deadline,self._cancel_event)
                        if result.get("status") not in {"succeeded","failed","cancelled"}:
                            raise RuntimeHalt("interrupted","子任务停止尚未确认，未派发新动作")
                stage["status"]="blocked"; stage["block_reason"]="玩家终止当前子任务，请基于已有事实重新决策，不要自动重派相同任务"
                self.snap["last_error"]=stage["block_reason"]
                self._save("stage_cancelled",{"stage":stage})
            finally:
                self._cleanup=False
                if not self._cancel_event.is_set(): self._stop_sent=False; self._stop_action_id=None
        except ValidationError as e:
            stage["status"]="blocked"; stage["block_reason"]=str(e)
            self.snap["last_error"]=str(e)
        finally:
            self._worker_job=None
            if self.stage is not None:
                if self._stage_clock is not None:
                    stage["spent_seconds"]=stage.get("spent_seconds",0)+time.monotonic()-self._stage_clock
                self._save("stage_updated",{"stage":stage})
                self.stage=None; self._stage_clock=None

    async def _run_worker(self, stage):
        self.stage=stage
        self._stage_clock=time.monotonic()
        stage["status"]="running"; stage["attempt_id"]=uid("attempt")
        stage.setdefault("attempts",[]).append(stage["attempt_id"])
        scoped=copy.deepcopy(self.state)
        scoped.start_inventory=copy.deepcopy(self.state.start_inventory if stage.get("information_only") else
            {i["name"]:i["count"] for i in self.state.observation.raw["inventory"]})
        scoped.goal_baseline=dict(scoped.start_inventory or {})
        scoped.container_baselines={}
        if stage.get("saved_baselines"):
            scoped.start_inventory=stage["saved_baselines"]["inventory"]
            scoped.goal_baseline=dict(scoped.start_inventory or {})
            scoped.container_baselines=stage["saved_baselines"]["containers"]
        else:
            await self._baselines([c for c in stage["acceptance_checks"] if c.get("scope")=="stage"],scoped)
            stage["saved_baselines"]={"inventory":scoped.start_inventory,"containers":scoped.container_baselines}
        self._save("stage_started", {"stage":stage})
        failures=0
        stagnant_queries=0
        try:
            while True:
                try:
                    raw=await self._model("worker","complete_stage")
                    proposal=parse_proposal(raw,"worker")
                    self._save("proposal", {"role":"worker","proposal":proposal})
                    if proposal["kind"] in {"query","act"} and "verification" in proposal["payload"]:
                        await self._prepare_verification(proposal["payload"]["verification"],scoped)
                    if proposal["kind"] in {"query","act"}:
                        if stage.get("information_only") and proposal["kind"] == "act":
                            raise ValidationError("信息子任务不能执行变更动作")
                        novelty=sum(bool(e.get("novel")) for e in self.snap["evidence"])
                        await self._tool(proposal)
                        after=sum(bool(e.get("novel")) for e in self.snap["evidence"])
                        stagnant_queries=stagnant_queries+1 if after==novelty else 0
                        if stagnant_queries>=2:
                            stage["status"]="blocked"
                            stage["block_reason"]="重复查询没有新增事实，需要更改策略"
                            self.snap["last_error"]=stage["block_reason"]
                            return
                        failures=0
                        self.snap["last_error"]=None; self.snap["last_invalid_output"]=None
                    elif proposal["kind"]=="prepare_verification":
                        await self._prepare_verification(proposal["payload"],scoped)
                        failures=0
                        self.snap["last_error"]=None; self.snap["last_invalid_output"]=None
                    elif proposal["kind"]=="submit_result":
                        p=proposal["payload"]
                        refs(p["evidence_ids"],"evidence_ids",[e["id"] for e in self.snap["evidence"]])
                        if p["unresolved_items"]: raise ValidationError("仍有未解决事项不能提交阶段成功")
                        stage["candidate_result"]=p
                        if stage.get("information_only"):
                            ok=any(e.get("stage_id")==stage["id"] for e in self.snap["evidence"])
                            results=[]
                        else:
                            if not stage["acceptance_checks"]: raise ValidationError("阶段尚未建立可执行验收")
                            ok,results=await self._verify(stage["acceptance_checks"],scoped)
                        if not ok: raise ValidationError("阶段验收未通过："+canonical_json(results))
                        stage["status"]="succeeded"; stage["result"]=p
                        self.snap["progress"].append({"stage":stage["id"],"summary":p["summary"],"evidence_ids":p["evidence_ids"]})
                        self.snap["last_error"]=None
                        self._save("stage_verified", {"stage":stage})
                        return
                    else:
                        stage["status"]="blocked"; self.snap["last_error"]=proposal["payload"]
                        stage["block_reason"]=proposal["payload"]
                        self._save("stage_blocked", {"stage":stage}); return
                except ValidationError as e:
                    failures+=1; self.snap["last_error"]=str(e)
                    self.snap["last_invalid_output"]=raw if "raw" in locals() else None
                    self.snap["last_invalid_role"]="worker"
                    self._save("rejected", {"role":"worker","error":str(e)})
                    if failures>=self._config.orchestration.max_local_failures:
                        stage["status"]="blocked"; stage["block_reason"]=str(e); return
        finally:
            stage["spent_seconds"]=stage.get("spent_seconds",0)+time.monotonic()-self._stage_clock
            self._stage_clock=None
            self._save("stage_updated", {"stage":stage})
            self.stage=None

    async def _report(self, p):
        if not self.snap.get("contract"):
            if not p.get("contract_draft"): raise ValidationError("首次报告必须附contract_draft")
            await self._accept_contract(p["contract_draft"])
        c=TaskContract(self.snap["contract"])
        refs(p["requirement_ids"],"requirement_ids",c.requirement_ids,1)
        report=parse_report(p["report"],c,self.snap["evidence"])
        if not c.checks_ready:
            raise ValidationError("先派发Worker编译交付完成标准，不能凭报告文本完成")
        # Verify all world requirements before allowing a success report to be sent.
        work_checks=[k for k in c.checks if k["kind"] not in {"grounded_report","delivery_submission"}]
        self._status("verifying"); self._finalizing=True
        ok,_=await self._verify(work_checks,self.state,root=True,report=report)
        if not ok: self._finalizing=False; raise ValidationError("实际工作未通过验收，不能发送完成报告")
        if not c.required_result_ids<=set(report["covered_requirement_ids"]):
            raise ValidationError("最终报告遗漏必要需求")
        report["id"]=uid("report")
        self.snap["report"]=report; self.snap["report_verified"]=True
        self.snap["work_status"]="verified"
        self._save("report_created", {"report":report})
        self._status("delivering")
        await self._deliver(report)
        self.snap["delivery_status"]="submitted"
        ok,_=await self._verify([k for k in c.checks if k["kind"] in {"grounded_report","delivery_submission"}],self.state,root=True,report=report)
        if not ok: raise ValidationError("报告交付验收未通过")
        self._status("completed")
        raise RuntimeHalt("completed",report["text"])

    async def _deliver(self, report):
        async def send(text):
            if self.delivery_channel=="cli":
                if self.terminal_emit is None: raise ValidationError("缺少终端输出适配器")
                self.terminal_emit(text)
                return {"sent":True}
            return await self._request("say",{"message":text},self.deadline,self._cancel_event,timeout=3.)
        self.snap["delivery_status"]="pending"
        delivery=DeliveryService(self.store,interval=0) if self.delivery_channel=="cli" else self.delivery
        await delivery.submit(report,send,self.check,self._save)

    async def _coordinator_step(self, proposal):
        kind,p=proposal["kind"],proposal["payload"]
        if kind=="answer":
            if self.snap.get("contract") or self.snap.get("mutations_started"):
                raise ValidationError("已有动作任务不能通过answer绕过实际验收")
            text=self.snap["request"]["command_text"]
            await self._accept_contract({"intent_summary":text,"requirements":[{"id":"r1","text":text,"source_refs":[text]}],
                "constraints":{},"deliverables":[{"id":"answer","description":"回答玩家问题","requirement_ids":["r1"],
                "acceptance_checks":[{"kind":"grounded_report","required_topics":[text],"permitted_evidence_kinds":["observe","find_blocks","recipes","inspect_container","action","task_history"]},
                {"kind":"delivery_submission","channel":self.delivery_channel}]}]})
            await self._report({"report":p["report"],"requirement_ids":["r1"]})
        elif kind=="delegate":
            if p.get("contract_draft"): await self._accept_contract(p["contract_draft"])
            stage=p["stage"]
            retained=[{k:v for k,v in s.items() if k in {"id","title","objective","requirement_ids","dependencies","mode","completion_criteria","input_evidence_ids","expected_outputs","budget"}}
                      for s in self.snap["stages"] if s.get("status")=="succeeded"]
            await self._coordinator_step({"kind":"propose_plan","payload":{"stages":retained+[stage],"change_reason":proposal["summary"],"based_on_evidence_ids":stage.get("input_evidence_ids",[])}})
            await self._coordinator_step({"kind":"dispatch","payload":{"stage_id":stage["id"]}})
        elif kind=="propose_contract": await self._accept_contract(p["contract_draft"])
        elif kind=="request_information":
            requested=refs(p["requested_capabilities"],"requested_capabilities",READ_ONLY,1) if "requested_capabilities" in p else sorted(READ_ONLY & self.snap["capabilities"].keys())
            refs(p["evidence_refs"],"evidence_refs",[e["id"] for e in self.snap["evidence"]])
            stage={"id":uid("info"),"title":p["question"],"objective":p["question"],"dependencies":[],
                   "allowed_capabilities":requested,"acceptance_checks":[],"information_only":True}
            await self._worker(stage)
        elif kind=="propose_plan":
            if not self.snap.get("contract"): raise ValidationError("先建立任务约定")
            refs(p["based_on_evidence_ids"],"based_on_evidence_ids",[e["id"] for e in self.snap["evidence"]])
            old={s["id"]:s for s in self.snap["stages"]}
            completed={k for k,s in old.items() if s.get("status")=="succeeded"}
            stages=parse_stages(p["stages"],TaskContract(self.snap["contract"]),self.snap["capabilities"],
                                self._config.orchestration.max_plan_stages,completed)
            for s in stages:
                refs(s["input_evidence_ids"],"input_evidence_ids",[e["id"] for e in self.snap["evidence"]])
                self.snap["pinned_evidence"]=list(set(self.snap.get("pinned_evidence",[])) | set(s["input_evidence_ids"]))
                if s["id"] in old and old[s["id"]].get("status")=="succeeded":
                    previous=old[s["id"]]
                    if any(s.get(k)!=previous.get(k) for k in ("objective","completion_criteria","dependencies")) or ("completion_criteria" not in s and s["acceptance_checks"]!=previous["acceptance_checks"]):
                        raise ValidationError("不能改写已完成阶段")
                    s.update(previous)
                elif s["id"] in old:
                    for field in ("saved_baselines","attempts","spent","spent_seconds"):
                        if field in old[s["id"]]: s[field]=old[s["id"]][field]
                    if s.get("completion_criteria")==old[s["id"]].get("completion_criteria") and s["objective"]==old[s["id"]]["objective"]:
                        s["acceptance_checks"]=old[s["id"]]["acceptance_checks"]
            for s in old.values():
                if s.get("status")=="succeeded" and s["id"] not in {x["id"] for x in stages}: stages.append(s)
            self.snap["stages"]=stages; self.snap["plan_revision"]+=1
            self._save("plan_revised", {"stages":stages,"reason":p["change_reason"]})
            self._status("planning")
        elif kind=="dispatch":
            stage=next((s for s in self.snap["stages"] if s["id"]==p["stage_id"]),None)
            if not stage or stage.get("status")=="succeeded": raise ValidationError("阶段不存在或已经完成")
            done={s["id"] for s in self.snap["stages"] if s.get("status")=="succeeded"}
            if not set(stage["dependencies"])<=done: raise ValidationError("阶段依赖尚未完成")
            self._status("executing")
            await self._worker(stage)
            self._status("planning")
        elif kind=="clarify":
            question=text_value(p["question"],"question",300)
            self.snap["question"]={"id":uid("question"),"text":question}
            self._status("waiting_input")
            raise RuntimeHalt("needs_clarification",question)
        elif kind=="submit_report": await self._report(p)
        elif kind=="request_completion":
            raise ValidationError("先提交覆盖全部需求的报告，程序验收和交付后才完成")
        elif kind=="cannot_complete":
            raise RuntimeHalt("failed",text_value(p["explanation"],"explanation"))

    def _restore_state(self, saved):
        state=TaskState(task_id=self._task_id,task_text=self.snap["request"]["command_text"])
        if saved:
            for field in ("start_inventory","goal_baseline","container_baselines","constraints","facts","world_id","usage"):
                if saved.get(field) is not None: setattr(state,field,copy.deepcopy(saved[field]))
            if saved.get("final_observation"): state.observation=Observation(saved["final_observation"])
            for s in saved.get("steps",[]):
                allowed=set(StepRecord.__dataclass_fields__)
                state.steps.append(StepRecord(**{k:v for k,v in s.items() if k in allowed}))
        state.task_version=self.snap["task_version"]
        return state

    async def run(self,task_text,goal_json=None,*,task_id=None,task_version=1,continuation_context=None,requested_by=None,raw_chat=None,resume_root=None):
        if self._active: raise ValidationError("已有任务运行")
        if goal_json is not None: raise ValidationError("hierarchical不支持--goal-json；请用legacy工程测试")
        text_value(task_text,"task",1000)
        previous=None
        if resume_root: previous=self.store.read_task(resume_root)
        elif continuation_context and continuation_context.get("previous_root_task_id"):
            previous=self.store.read_task(continuation_context["previous_root_task_id"])
        if previous and previous["status"] not in {"waiting_input","interrupted","cancelled","superseded"}:
            raise ValidationError("任务不能续接")
        if resume_root and previous["status"] != "interrupted":
            raise ValidationError("只能显式恢复interrupted任务；取消/终结的任务不能复活")
        if previous and continuation_context and continuation_context.get("answer"):
            if previous["status"] != "waiting_input" or not previous.get("question"):
                raise ValidationError("没有可回答的当前问题，旧答案不能复活已取消任务")
        if previous is None and self.pending():
            raise ValidationError("有暂停/中断任务，请先回答、继续或停止")
        self._active=True; self._cancel_event=asyncio.Event(); self._cancel_reason=""
        self._interrupted=False
        self._stop_sent=False; self._pending_action=None; self._stop_action_id=None
        self._finalizing=False; self._cleanup=False; self.stage=None
        self._task_id=task_id or uid("task"); started=utc_now(); started_mono=time.monotonic()
        if previous:
            if previous["status"] not in {"waiting_input","interrupted","cancelled","superseded"}: self._active=False; raise ValidationError("任务不能续接")
            self.snap=previous
            self.snap["task_id"]=self._task_id
            if not resume_root:
                a={"id":uid("amendment"),"type":"correction" if continuation_context.get("correction") else "clarification",
                   "author":requested_by,"text":continuation_context.get("correction") or continuation_context.get("answer") or continuation_context.get("supplement") or task_text,
                   "raw_chat":raw_chat or task_text,
                   "received_at":utc_now(),"question_id":(previous.get("question") or {}).get("id")}
                self.snap["request"]["amendments"].append(a)
                self.snap["task_version"]+=1; self.snap["contract"]=None; self.snap["question"]=None
                self.snap["report"]=None; self.snap["report_verified"]=False; self.snap["delivery_status"]="pending"
                self.snap["mutations_started"]=False
            self.snap["status"]="interpreting"
        else:
            self.snap={"root_task_id":uid("root"),"task_id":self._task_id,"task_version":task_version,"revision":0,
                "status":"received","contract_revision":0,"plan_revision":0,"contract":None,"stages":[],"evidence":[],
                "progress":[],"report":None,"report_verified":False,"delivery_status":"pending","work_status":"unverified",
                "request":{"raw_chat":raw_chat or task_text,"command_text":task_text,"requester":requested_by,
                           "received_at":started,"amendments":[]},"budget":{},"mutations_started":False}
        self.budget=Budget(self._config.agent.task_timeout_seconds,self._config.agent.max_steps,
                           self._config.orchestration.max_model_calls,self.snap.get("budget"))
        self.deadline=time.monotonic()+max(0,self.budget.remaining)
        self.state=self._restore_state(self.snap.get("state"))
        self.state.constraints=merge_constraints(self.state.constraints,explicit_constraints(task_text))
        self._save("task_start", {"task":self.snap["request"]["command_text"],"requested_by":requested_by,
                                  "request":self.snap["request"],"stages":self.snap["stages"],
                                  "learning_mode":"B0","max_steps":self._config.agent.max_steps})
        final="failed"; message="任务未完成"
        try:
            await self._observe(self.deadline,self._cancel_event)
            if not previous and continuation_context and continuation_context.get("session_previous_outcome"):
                prior=continuation_context["session_previous_outcome"]
                self._evidence("task_history",prior,origin=prior.get("task_id"))
            self.state.goal_baseline=dict(self.state.start_inventory or {})
            capabilities=self.state.observation.raw.get("capabilities",[])
            self.snap["capabilities"]={k:v for k,v in CAPABILITIES.items() if k in capabilities or ("act" in capabilities and k not in READ_ONLY|{"inspect_container"})}
            # Legacy fakes may only advertise observe/act. Real executors advertise all supported operations.
            self.snap["capabilities"]["observe"]=CAPABILITIES["observe"]
            uncertain=[a for a in self.store.actions(self.snap["root_task_id"]) if a.get("status") in {"unknown","submitting","acknowledged"}]
            if uncertain:
                self.snap["question"]={"id":uid("question"),"text":"上次动作结果不明确，请核对物品变化后取消并重新下达剩余任务。"}
                self.snap["status"]="waiting_input"
                raise RuntimeHalt("needs_clarification",self.snap["question"]["text"])
            # A crash may occur after terminal action journalling but before the StepRecord transaction.
            # Restore the known result rather than letting the next Worker mistake it for unexecuted work.
            known={s.action_id for s in self.state.steps if s.action_id}
            for a in self.store.actions(self.snap["root_task_id"]):
                result=a.get("result",{})
                if a.get("op")=="act" and a.get("status")=="settled" and a.get("action_id") not in known:
                    if result.get("status") not in {"succeeded","failed","cancelled"}: continue
                    self.state.add_step(StepRecord(index=len(self.state.steps)+1,op="act",args=a["args"],
                        status=result["status"],started_at=utc_now(),finished_at=utc_now(),action_id=a["action_id"],
                        result=result,evidence={"action":result,"recovered_from_journal":True}))
                    self._evidence("action",{"args":a["args"],"status":result["status"],"result":result,
                        "recovered_from_journal":True},a["action_id"],stage_id=a.get("stage_id"))
            if resume_root and self.snap.get("report_verified") and self.snap.get("report"):
                self._status("verifying")
                checks=[c for c in TaskContract(self.snap["contract"]).checks if c["kind"] not in {"delivery_submission","grounded_report"}]
                self._finalizing=True
                ok,_=await self._verify(checks,self.state,root=True,report=self.snap["report"])
                if not ok: raise RuntimeHalt("failed","恢复核对发现工作状态不再满足要求")
                self._status("delivering"); await self._deliver(self.snap["report"])
                self.snap["delivery_status"]="submitted"; self._status("completed")
                raise RuntimeHalt("completed",self.snap["report"]["text"])
            self.snap["status"]="interpreting" if not self.snap.get("contract") else "planning"
            repairs=0; stalls=0; replans=0; contract_repairs=0
            while True:
                self.check()
                before=(sum(bool(e.get("novel")) for e in self.snap["evidence"]),len(self.snap["progress"]),bool(self.snap.get("contract")))
                try:
                    raw=await self._model("coordinator","advance_task")
                    proposal=parse_proposal(raw,"coordinator",business=getattr(self.team,"protocol_version",None)=="business.v2")
                    self._save("proposal", {"role":"coordinator","proposal":proposal})
                    await self._coordinator_step(proposal)
                    repairs=0
                    self.snap["last_invalid_output"]=None
                    if not any(s.get("status")=="blocked" for s in self.snap["stages"]): self.snap["last_error"]=None
                except ValidationError as e:
                    repairs+=1; self.snap["last_error"]=str(e)
                    self.snap["last_invalid_output"]=raw if "raw" in locals() else None
                    self.snap["last_invalid_role"]="coordinator"
                    if "语义验收" in str(e): contract_repairs+=1
                    self._save("rejected", {"error":str(e),"role":"coordinator"})
                    if repairs>self._config.orchestration.max_schema_repairs or contract_repairs>self._config.orchestration.max_contract_repairs:
                        raise RuntimeHalt("failed","提议或语义约定多次校验失败："+str(e))
                after=(sum(bool(e.get("novel")) for e in self.snap["evidence"]),len(self.snap["progress"]),bool(self.snap.get("contract")))
                stalls=stalls+1 if before==after else 0
                if stalls>=2 and repairs==0:
                    replans+=1; stalls=0
                    self.snap["last_error"]="最近未获得新事实或完成阶段，请更改策略，不要只改写计划。"
                    self._save("stall_detected", {"replans":replans})
                    if replans>self._config.orchestration.max_replans: raise RuntimeHalt("failed","多次重规划仍无实际进展")
        except RuntimeHalt as halt: final,message=halt.status,halt.message
        except (TaskCancelled,asyncio.CancelledError):
            final,message=("interrupted" if self._interrupted else "cancelled"),self._cancel_reason or "任务已取消"
        except DeadlineExceeded as e: final,message="exhausted",str(e)
        except (TransportError,OperationTimeout) as e: final,message="interrupted",str(e)
        except AgentError as e: final,message="failed",str(e)
        except Exception as e:
            final,message="failed","运行异常："+type(e).__name__
            self._save("runtime_error", {"error_type":type(e).__name__})
        finally:
            if final not in {"completed","needs_clarification"}:
                self._cleanup=True
                await self._stop_once()
                await self._capture_interrupted_action(self.state)
                self._cleanup=False
                for a in self.store.actions(self.snap["root_task_id"]):
                    if a.get("session_id")==self.session_id and a.get("action_id") and a.get("status")=="acknowledged":
                        try:
                            result=await asyncio.wait_for(self._backend.request("action_status",{"action_id":a["action_id"]},timeout=2),2.1)
                            if result.get("status") in {"succeeded","failed","cancelled"} and not (result.get("effect") or {}).get("effect_unknown"):
                                self.store.journal(self.snap["root_task_id"],self.session_id,{**a,"status":"settled","result":result},a["id"])
                        except Exception: pass
                unsettled=[a for a in self.store.actions(self.snap["root_task_id"]) if a.get("status") in {"unknown","submitting","acknowledged"}]
                if unsettled: final="interrupted"
            self.snap["status"]="waiting_input" if final=="needs_clarification" else final
            self.snap["last_message"]=message
            self._save("task_end", {"task":self.snap["request"]["command_text"],"end_state":final,"message":message,
                "work_status":self.snap["work_status"],"delivery_status":self.snap["delivery_status"],
                "usage":self._usage(),"observation":self.state.observation.raw if self.state.observation else None})
            self._active=False
        return TaskOutcome(task_id=self._task_id,root_task_id=self.snap["root_task_id"],task_text=self.snap["request"]["command_text"],
            task_version=self.snap["task_version"],end_state=final,message=message,started_at=started,finished_at=utc_now(),
            duration_seconds=time.monotonic()-started_mono,steps=[s.to_dict() for s in self.state.steps],
            final_observation=self.state.observation.raw if self.state.observation else None,usage=self._usage(),
            work_status=self.snap["work_status"],delivery_status=self.snap["delivery_status"],recovery_required=final=="interrupted")
