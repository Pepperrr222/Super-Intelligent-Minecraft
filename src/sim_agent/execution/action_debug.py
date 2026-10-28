"""One skill, one shared controller, zero model calls or planning loops."""
import asyncio
import time
import uuid

from sim_agent.execution.controller import ExecutionController
from sim_agent.execution.runner import TaskOutcome
from sim_agent.domain.debug_command import parse_debug_command
from sim_agent.domain.errors import AgentError, TaskCancelled, DeadlineExceeded, TransportError, ValidationError
from sim_agent.domain.state import TaskState, StepRecord
from sim_agent.observability.jsonl import utc_now


class ActionDebugRunner(ExecutionController):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self._unsafe=False

    @property
    def active(self): return self._active

    @property
    def task_id(self): return self._task_id

    async def run(self,task_text,goal_json=None,*,task_id=None,task_version=1,continuation_context=None,requested_by=None):
        if self.active: raise ValidationError("已有动作正在执行")
        if goal_json is not None or continuation_context: raise ValidationError("动作调试不接受自定义目标或任务续接")
        started=utc_now(); clock=time.monotonic()
        self._task_id=task_id or 'debug-'+uuid.uuid4().hex
        self._active=True;self._cancel_event=asyncio.Event();self._cancel_reason=''
        self._stop_sent=False;self._stop_action_id=None;self._pending_action=None
        state=TaskState(task_id=self.task_id,task_text=task_text,task_version=task_version)
        deadline=clock+min(60,self._config.agent.task_timeout_seconds)
        status='failed';message='动作未完成';error=None;verification=None
        attempted=False;gain=None;unknown=False;command=None
        self._logs.trace({'type':'task_start','task_id':self.task_id,'task':task_text,'mode':'action_debug',
                          'requested_by':requested_by,'task_version':task_version,'learning_mode':'B0','max_steps':1})
        try:
            if self._unsafe: raise ValidationError("上次动作效果未知，需核对并重新连接执行器，不能自动启动新动作")
            command=parse_debug_command(task_text)
            if command.call is None:
                status='cancelled';message='没有正在执行的动作。'
            else:
                state.goal=command.goal
                state.apply_observation(await self._observe(deadline,self._cancel_event))
                state.goal_baseline=dict(state.start_inventory or {})
                self._logs.trace({'type':'goal_bound','task_id':self.task_id,'goal':state.goal.to_dict()})
                self._logs.trace({'type':'execution','task_id':self.task_id,'step':1,'op':'act','args':command.call.args})
                attempted=True
                result=await self._execute(command.call,state,deadline,self._cancel_event)
                state.add_step(StepRecord(index=1,op='act',args=command.call.args,status=result.status,
                    started_at=started,finished_at=utc_now(),result=result.result,error=result.error,
                    action_id=result.action_id,evidence=result.evidence))
                if result.status!='succeeded':
                    phase=(result.result or {}).get('effect',{}).get('phase','unknown')
                    raise ValidationError(f"动作失败阶段[{phase}]："+(result.error or '动作执行失败'))
                if command.call.args['kind']=='collect':
                    mined=(result.result or {}).get('effect',{}).get('mined_count')
                    if isinstance(mined,bool) or not isinstance(mined,int) or mined<command.call.args['count']:
                        raise ValidationError('缺少足量方块挖掘证据，不能只凭物品增长判定完成')
                checked=await self._verify_live(state.goal,state,deadline,self._cancel_event)
                verification=checked.to_dict()
                self._logs.trace({'type':'verification','task_id':self.task_id,'verification':verification})
                if not checked.ok: raise ValidationError(checked.detail)
                status='completed';message='动作完成：'+checked.detail
        except TaskCancelled:
            status='cancelled';message='停止请求已处理，保留已发生的效果。'
        except asyncio.CancelledError:
            status='cancelled';message='动作已中断，保留已发生的效果。'
        except DeadlineExceeded as exc:
            status='exhausted';message='动作时间预算耗尽。';error=str(exc)
        except TransportError as exc:
            status='interrupted';message='执行器状态无法确认，效果需要核对：'+str(exc);error=str(exc)
        except ValidationError as exc:
            status='failed' if attempted else 'needs_clarification';message=str(exc);error=str(exc)
        except AgentError as exc:
            status='failed';message=str(exc);error=str(exc)
        except Exception as exc:
            status='failed';message='动作调试异常：'+type(exc).__name__;error=type(exc).__name__
        finally:
            if self._unsafe and not attempted:
                status='interrupted';unknown=True
            if attempted and status!='completed':
                await self._stop_once()
                await self._capture_interrupted_action(state)
                unknown=self._effect_unknown or not state.steps or state.steps[-1].status not in {'succeeded','failed','cancelled'}
                if unknown:
                    self._unsafe=True;status='interrupted';message+=' 旧动作结果未确认，禁止自动重放。'
            if attempted:
                try:
                    state.apply_observation(await asyncio.wait_for(self._backend.request('observe',{},timeout=2),2.1))
                    if command and command.call.args['kind']=='collect':
                        item=command.call.args['block']
                        final={i['name']:i['count'] for i in state.observation.raw['inventory']}
                        gain=final.get(item,0)-(state.start_inventory or {}).get(item,0)
                except Exception:
                    if status=='completed':
                        status='interrupted';unknown=True;message='最终状态无法确认。'
            self._active=False
        if gain is not None:
            message+=f" 已确认目标物品变化 {gain:+d}，请求 {command.call.args['count']}。"
        usage={'model_calls':0,'planning_calls':0,'total_tokens':0}
        outcome=TaskOutcome(task_id=self.task_id,task_text=task_text,end_state=status,message=message,
            started_at=started,finished_at=utc_now(),duration_seconds=time.monotonic()-clock,
            goal=state.goal.to_dict() if state.goal else None,verification=verification,error=error,
            steps=[s.to_dict() for s in state.steps],usage=usage,task_version=task_version,
            final_observation=state.observation.raw if state.observation else None,
            work_status='verified' if status=='completed' else 'unverified',recovery_required=unknown)
        event={'type':'task_end','task_id':self.task_id,'task':task_text,'mode':'action_debug',
               **outcome.to_dict(),'observation':outcome.final_observation,'gained_count':gain,'effect_unknown':unknown}
        self._logs.trace(event);self._logs.task(event)
        return outcome
