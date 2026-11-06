import { randomUUID, createHash } from 'node:crypto';
import type { LlmClient } from './llm.js';
import type { BasicOperation } from './schema.js';
import { availableOperations, operationCatalog } from './basic-operations.js';
import { handPrerequisite, stableFacts } from './agent-preflight.js';
import { packAgentContext } from './agent-context.js';
import {runStage,type StagePlan,type StageState} from './stage-plan.js';
import type { MemoryPort } from './resource-memory.js';
import type { ChatTransport, PlayerMessage, SchedulerPort } from './interaction.js';
import type { ActionPort, ControllerPort, TaskSnapshot } from './task.js';
import type { DiagnosticBus } from './diagnostics.js';
import { type AgentStore, MemoryAgentStore } from './agent-store.js';
import { isOpenGoal, publicEvidence, type AgentGoal, type AgentState, type AgentEvent, type AgentDecision, type Assessment } from './agent-contract.js';
import { AGENT_PROMPT_VERSION } from './agent-prompts.js';
import { QUERY_CONTRACTS } from './tool-contracts.js';
import { AgentBrain, type BrainRole, type BrainResult } from './agent-brain.js';

export type AgentLoopOptions = {
  memory?:MemoryPort;
  validateOperations?:(operations:BasicOperation[])=>string | undefined;
  owners?: string[]; botName?: string; model?: LlmClient; director?: LlmClient; executor?: LlmClient;
  store?: AgentStore; diagnostics?: DiagnosticBus; capabilities?: readonly string[];
  maxCalls?: number; maxOperations?: number; activeMs?: number; lifetimeMs?: number;
  callTimeoutMs?: number; maxContextBytes?: number;
  requirePromptApproval?: boolean; approvedPromptHash?: string;
  subscribeWorld?: (wake: () => void) => () => void;
};
type Inbox = { message: PlayerMessage; resolve: () => void };
const terminal = (state: string) => ['completed', 'failed', 'cancelled', 'blocked'].includes(state);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const signature = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Event-driven, one-writer goal loop. Models propose; only this loop submits basic operations. */
export class AgentLoop {
  readonly brain: AgentBrain;
  private state: AgentState;
  private readonly store: AgentStore;
  private inbox: Inbox[] = [];
  private worker?: Promise<void>;
  private callAbort?: AbortController;
  private unsubscribe?: () => void;
  private unsubscribeWorld?: () => void;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private storageFailed = false;
  private epoch = 0;
  private controlGeneration = 0;
  private activeBatch?: string;
  private rate = new Map<string, number[]>();
  private seen = new Set<string>();
  private recovered = false;
  private unsubscribeMemory?:()=>void;

  constructor(private readonly transport: ChatTransport, private readonly actions: ActionPort,
    private readonly controller: ControllerPort, private readonly scheduler: SchedulerPort,
    private readonly options: AgentLoopOptions = {}) {
    this.brain = new AgentBrain(options);
    this.store = options.store ?? new MemoryAgentStore();
    this.state = this.store.load();
    if(this.state.goal?.stage?.status==='running') {
      this.state.goal.stage.status='interrupted';this.state.goal.stage.reason='运行时恢复；保留游标和已确认结果，剩余步骤需重新观察并提交方案，不能重放 pendingNode';
    }
    if (this.state.resources) options.memory?.restore(this.state.resources);
    this.unsubscribeMemory = options.memory?.subscribe(() => {
      this.state.resources = options.memory!.snapshot();
      try { this.save(); } catch (error) { this.options.diagnostics?.emit('runtime','error','资源记忆存储失败，已停止动作',error); }
    });
    if (isOpenGoal(this.state.goal) && ['active', 'waiting_world', 'reconciling'].includes(this.state.goal.status)) {
      this.state.goal.status = this.state.goal.pendingBatch ? 'reconciling' : 'active'; this.recovered = true;
    }
  }
  get snapshot(): AgentState { return structuredClone(this.state); }
  start(): () => void {
    if (this.closed) throw new Error('AGENT_CLOSED');
    this.unsubscribe ??= this.transport.onMessage(message => { void this.handle(message); });
    this.unsubscribeWorld ??= this.options.subscribeWorld?.(() => this.wake());
    if (this.recovered) {
      this.recovered = false;
      const goal = this.state.goal!;
      if (!this.owner(goal.owner)) { goal.status = 'paused'; this.record('control', { reason: '恢复权限已变化' }); }
      else { this.record('control', { reason: '启动恢复，旧引用无效，先观察对账' }); this.kick(); }
    }
    return () => { this.stop(); };
  }
  /** Runtime shutdown preserves a recoverable goal; player cancel is handled separately. */
  stop(): void {
    if (this.closed) return;
    this.closed = true; this.epoch++; this.controlGeneration++; this.callAbort?.abort(); clearTimeout(this.wakeTimer);
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.unsubscribeWorld?.(); this.unsubscribeWorld = undefined;
    this.unsubscribeMemory?.(); this.unsubscribeMemory = undefined;
    this.scheduler.stop('运行时停止'); this.controller.stop('运行时停止');
    for (const item of this.inbox.splice(0)) item.resolve();
    // Leave pendingBatch durable until native work settles or restart reconciles it.
    void this.whenIdle().finally(() => this.store.close());
  }
  async whenIdle(): Promise<void> { while (this.worker) await this.worker; }
  private wake() {
    const goal = this.state.goal;
    if (this.closed || this.storageFailed || goal?.status !== 'waiting_world') return;
    clearTimeout(this.wakeTimer); goal.status = 'active'; this.kick();
  }
  private owner(player: string) { return !this.options.owners?.length || this.options.owners.some(p => p.toLowerCase() === player.toLowerCase()); }
  async handle(message: PlayerMessage): Promise<void> {
    if (this.closed || !message.text.trim() || message.text.length > 2000 || message.player === this.options.botName) return;
    if (!this.owner(message.player)) { this.transport.send(message.player, '当前只接受已授权玩家的指令。'); return; }
    const text = message.text.trim();
    // Exact safety controls only; "停止后去..." requires semantic routing.
    const control = /^(停|停下|停止|停下来|别动|stop|halt|取消|取消任务|不做了|cancel)[!！。\s]*$/iu.test(text) ? 'cancel'
      : /^(暂停|先停一下|等一下|pause)[!！。\s]*$/iu.test(text) ? 'pause'
      : /^(继续|接着做|恢复|resume)[!！。\s]*$/iu.test(text) ? 'resume' : undefined;
    if (control && control !== 'resume') { this.control(control, message.player); return; }
    if (this.storageFailed) { this.transport.send(message.player, '任务记录写入失败，已停止新增操作；请修复存储后重启。'); return; }
    const key = `${message.player}:${message.id}`;
    if (this.seen.has(key) || this.state.events.some(e => e.kind === 'message' && (e.data as any)?.id === message.id && (e.data as any)?.player === message.player)) return;
    const now = Date.now(), recent = (this.rate.get(message.player) ?? []).filter(t => t > now - 10_000);
    if (recent.length >= 8 || this.inbox.length >= 16) { this.transport.send(message.player, '消息较多，请稍等当前处理。'); return; }
    this.rate.set(message.player, [...recent, now]); this.seen.add(key);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value!);
    if (control === 'resume') {
      this.record('message',message); this.control(control,message.player); return;
    }
    this.epoch++; this.callAbort?.abort();
    await new Promise<void>(resolve => { this.inbox.push({ message, resolve }); this.kick(); });
  }
  private control(action: 'cancel' | 'pause' | 'resume', player: string) {
    const goal = this.state.goal;
    if (isOpenGoal(goal) && goal.owner.toLowerCase() !== player.toLowerCase()) {
      // Any configured owner may stop for safety, but may not resume another player's work.
      if (action !== 'cancel') { this.transport.send(player, '当前任务属于另一位玩家。'); return; }
    }
    this.epoch++; this.controlGeneration++; this.callAbort?.abort(); clearTimeout(this.wakeTimer);
    if (action !== 'resume') {
      this.state.pendingRequest = undefined;
      for (const item of this.inbox.splice(0)) item.resolve();
      this.scheduler.stop(action); this.controller.stop(action);
    }
    if (goal && isOpenGoal(goal)) {
      if (action === 'resume') {
        this.renewExecutionWindow(goal,'player_resume');
        goal.noProgress = 0; goal.reconciliationFailures = 0;
      }
      goal.revision++;
      goal.status = action === 'cancel' ? 'cancelled' : action === 'pause' ? 'paused' : goal.pendingBatch ? 'reconciling' : 'active';
      try { this.record('control', { action, player }); } catch { /* stop remains effective when storage is broken */ }
      this.transport.send(player, action === 'cancel' ? '已停止；正在结束的原生操作会保持占用直到释放。' : action === 'pause' ? '已暂停，进度已保留。' : '继续前先核对当前状态。');
      if (action === 'resume' && !this.storageFailed) this.kick();
    } else {
      if (!this.storageFailed) { try { this.record('control', { action, player }); } catch { /* stop still succeeds */ } }
      this.transport.send(player, action === 'cancel' ? '已停止，尚未提交的指令也已取消。' : '当前没有可继续或暂停的活动目标。');
    }
  }
  private executionBudget():AgentGoal['budget'] {
    return {calls:this.options.maxCalls ?? 60,operations:this.options.maxOperations ?? 128,activeMs:this.options.activeMs ?? 900_000};
  }
  /** Only a fresh owner instruction can open another bounded execution window. */
  private renewExecutionWindow(goal:AgentGoal, reason:string, freshInstruction=false) {
    if (!freshInstruction && goal.budget.calls >= 3 && goal.budget.operations >= 4 && goal.budget.activeMs > 0 && Date.now() < goal.deadline) return;
    const previous = {...goal.budget}, previousDeadline = goal.deadline;
    goal.budget = this.executionBudget();
    goal.deadline = Date.now() + (this.options.lifetimeMs ?? 86_400_000);
    this.record('memory',{reason:'execution_window_renewed',trigger:reason,previous,previousDeadline,
      budget:goal.budget,deadline:goal.deadline,preservedPendingBatch:goal.pendingBatch?.id});
  }
  private kick() {
    if (this.worker || this.closed || this.storageFailed) return;
    this.worker = this.run().catch(error => {
      this.options.diagnostics?.emit('runtime', 'error', 'V2 循环停止', error);
      this.scheduler.stop('V2 循环异常'); this.controller.stop('V2 循环异常');
      for (const entry of this.inbox.splice(0)) entry.resolve();
    }).finally(() => {
      this.worker = undefined;
      if (this.storageFailed) for (const entry of this.inbox.splice(0)) entry.resolve();
      if (!this.closed && !this.storageFailed && this.inbox.length) this.kick();
    });
  }
  private async run() {
    while (!this.closed && !this.storageFailed) {
      try {
        if (this.inbox.length) { await this.consumeMessage(); continue; }
        const goal = this.state.goal;
        if (!isOpenGoal(goal) || !['active', 'reconciling'].includes(goal.status)) return;
        if (Date.now() >= goal.deadline || goal.budget.activeMs <= 0 || goal.budget.calls <= 0 || goal.budget.operations <= 0) {
          this.pause('本轮执行额度已用完，进度已保留；发送“继续”可开启下一轮并先核对状态。未完成事项：' + goal.remaining.join('；')); return;
        }
        if (this.controller.busy) { await delay(25); goal.budget.activeMs = Math.max(0, goal.budget.activeMs - 25); continue; }
        const start = Date.now();
        try { await this.step(); }
        finally {
          if (this.state.goal?.id === goal.id) { goal.budget.activeMs = Math.max(0, goal.budget.activeMs - (Date.now() - start)); this.save(); }
        }
      } catch (error) {
        if (this.closed) return;
        if (error instanceof Error && error.message === 'STALE_AGENT_TURN') continue;
        if (this.storageFailed) { this.transport.send(this.state.goal?.owner ?? this.inbox[0]?.message.player ?? '', '任务记录写入失败，已停止新增操作。'); return; }
        this.record('error', { message: error instanceof Error ? error.message : String(error) });
        if (isOpenGoal(this.state.goal)) this.pause(error instanceof Error && error.message.startsWith('V2_CORE_CONTEXT_LIMIT')
          ? '当前要求或单份证据过大，压缩后仍无法处理；进度已保留，需要进一步缩小查询范围。'
          : '本轮处理失败，目标与进度已保留；可以继续后重试。');
        else if (this.inbox.length === 0) return;
      }
    }
  }
  private save() {
    if (this.closed || this.storageFailed) return;
    this.state.sequence++;
    try { this.store.save(this.state); }
    catch (error) { this.storageFailed = true; this.callAbort?.abort(); this.scheduler.stop('任务存储失败'); this.controller.stop('任务存储失败'); throw error; }
  }
  private record(kind: AgentEvent['kind'], data: unknown): AgentEvent {
    const goal = this.state.goal;
    const event: AgentEvent = { id: randomUUID(), at: Date.now(), goalId: goal?.id ?? null, revision: goal?.revision ?? 0, kind, data: publicEvidence(data) };
    this.state.events.push(event);
    if (this.state.events.length > 2000) {
      // Keep current-goal evidence; only archive records from older goals from the working snapshot.
      this.state.events = this.state.events.filter(e => e.goalId === goal?.id).slice(-2000);
    }
    this.save();
    this.options.diagnostics?.emit(kind === 'assessment' ? 'feedback' : 'dispatch', 'info', `V2 ${kind}`, event);
    return event;
  }
  private say(player: string, text: string) { this.record('reply', { player, text: text.slice(0, 600) }); this.transport.send(player, text.slice(0, 600)); }
  private pause(reason: string) {
    if (!this.state.goal) return;
    this.state.goal.status = 'paused'; this.record('control', { reason }); this.say(this.state.goal.owner, reason);
  }
  private check(epoch: number) { if (this.closed || this.storageFailed || epoch !== this.epoch) throw new Error('STALE_AGENT_TURN'); }
  private async call<R extends BrainRole>(role: R, payload: unknown, epoch: number): Promise<BrainResult<R>> {
    this.check(epoch);
    this.brain.assertReady(role);
    const contextLimit=this.options.maxContextBytes ?? 64_000;
    payload = packAgentContext(payload,contextLimit);
    let problem: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const goal = this.state.goal;
      // User interaction has its own bound (message rate + max 2 schema attempts per role).
      // A spent/expired execution budget must never disable questions or replacement commands.
      if (isOpenGoal(goal) && (payload as {trigger?:string})?.trigger !== 'player_message') {
        if (goal.budget.calls <= 0 || Date.now() >= goal.deadline) throw new Error('V2_CALL_BUDGET');
        goal.budget.calls--; this.save();
      }
      this.check(epoch);
      const abort = new AbortController(); this.callAbort = abort;
      this.options.diagnostics?.emit('model', 'start', `V2 ${role} 输入`, { promptVersion: AGENT_PROMPT_VERSION, payload, problem });
      let response;
      try { response = await this.brain.infer(role, payload, abort.signal, problem); }
      catch (error) { this.check(epoch); throw error; }
      finally { if (this.callAbort === abort) this.callAbort = undefined; }
      this.check(epoch);
      this.options.diagnostics?.emit('model', 'ok', `V2 ${role} 输出`, { text: response.raw });
      if (response.result.ok) return response.result.value;
      problem = response.result.correction;
    }
    throw new Error('V2_MODEL_SCHEMA_INVALID');
  }
  private observe() {
    const result = this.actions.query({ type: 'snapshot', radius: 16 });
    const event = this.record('observation', result);
    if (result.status === 'succeeded') {
      const data = publicEvidence(result.data) as any;
      const hash = signature({ position: data?.position, inventory: data?.inventory, equipment: data?.equipment,
        heldItem: data?.heldItem, dimension: data?.dimension });
      const goal = this.state.goal;
      if (goal && goal.lastState !== hash) { goal.lastState = hash; goal.noProgress = 0; }
    }
    return event;
  }
  private context(extra: Record<string, unknown> = {}) {
    const goal = this.state.goal;
    const all = this.state.events.filter(e => e.goalId === goal?.id);
    const evidence = all.filter(e => ['observation', 'query', 'batch'].includes(e.kind));
    const containerMemory = publicEvidence(this.actions.query({type:'container_memory',limit:8})) as any;
    if (Array.isArray(containerMemory?.data?.containers)) containerMemory.data.containers = containerMemory.data.containers.map((record:any) => {
      const {slots,...rest}=record;
      const items = new Map<string,{name:string;count:number;special:boolean}>();
      for(const slot of slots ?? []) {const key=`${slot.name}:${slot.special}`;
        const entry=items.get(key) ?? {name:slot.name,count:0,special:slot.special}; entry.count+=slot.count;items.set(key,entry);}
      return {...rest,items:[...items.values()].slice(0,12),itemsTruncated:items.size>12};
    });
    // Preserve the goal intact, offer an index for on-demand older evidence retrieval.
    const stage=goal?.stage;
    const modelGoal=goal && stage ? {...goal,stage:{id:stage.id,status:stage.status,cursor:stage.cursor,
      pendingNode:stage.pendingNode,reason:stage.reason,operations:stage.operations,transitions:stage.transitions,
      purpose:stage.plan.purpose,storedOutputNodes:Object.keys(stage.outputs),
      planEvidenceId:all.filter(e=>e.kind==='memory' && (e.data as any)?.stageId===stage.id && ['stage_validated','stage_approved'].includes((e.data as any)?.reason)).at(-1)?.id}} : goal;
    const latestObservation=all.filter(e=>e.kind==='observation').at(-1);
    const version=(latestObservation?.data as any)?.data?.version;
    const latestTool=all.filter(e=>e.kind==='query'||e.kind==='batch'||e.kind==='memory'&&(e.data as any)?.reason==='read_evidence').at(-1);
    const lastFailure=all.filter(e=>e.kind==='error').at(-1);
    const bounded=(e:AgentEvent|undefined)=>e && JSON.stringify(e).length>12000?{...e,data:{omitted:true}}:e;
    return { promptVersion: AGENT_PROMPT_VERSION, goal:modelGoal,
      freshEvidenceId:latestObservation?.id, lastTool:bounded(latestTool), lastFailure:bounded(lastFailure),
      queryContracts:QUERY_CONTRACTS,catalog:operationCatalog(version,this.options.capabilities).filter(c=>c.type!=='say'), pendingRequest: this.state.pendingRequest, recent: this.state.recent,
      craftingKnowledge:(this.state.craftingRequests ?? []).filter(r=>r.goalId===goal?.id).slice(-2)
        .map(r=> { const result=publicEvidence(this.actions.query(r.query)); return {query:r.query,
          result:JSON.stringify(result).length<16000 ? result : {omitted:true,instruction:'缩小 goals 或 includeDependencies=false'}}; }),
      containerMemory,
      evidence: evidence.slice(-6).map(e => e.kind==='query' && (e.data as any)?.query?.type==='crafting_options'
        ? {...e,data:{query:(e.data as any).query,instruction:'当前材料结果见 craftingKnowledge；历史完整结果可 read_evidence'}}
        : JSON.stringify(e).length <= 12_000 ? e : { ...e, data: { omitted: true, instruction: 'read_evidence 或缩小查询分页' } }),
      evidenceIndex: evidence.slice(-64).map(({ id, at, kind, revision }) => ({ id, at, kind, revision })),
      lastEvents: all.filter(e => !['observation', 'query'].includes(e.kind)).slice(-4), ...extra };
  }
  private async consumeMessage() {
    const entry = this.inbox.shift()!;
    const { message } = entry;
    const epoch = this.epoch;
    const controlGeneration = this.controlGeneration;
    try {
      this.state.recent.push({ player: message.player, text: message.text, at: message.receivedAt });
      this.state.recent = this.state.recent.slice(-16);
      this.record('message', message); this.observe();
      const route = await this.call('decision', this.context({ trigger:'player_message', message }), epoch);
      const current = this.state.goal;
      if (route.kind === 'control') { this.control(route.action, message.player); return; }
      if (route.kind === 'respond') {
        this.say(message.player, route.text); return;
      }
      if (route.kind === 'ask') {
        this.state.pendingRequest = { player: message.player, id: message.id, text: message.text, at: message.receivedAt };
        this.say(message.player, route.question); return;
      }
      if (route.kind !== 'goal') {
        this.record('error',{code:'MESSAGE_DECISION_SCOPE',reason:'新消息先确定目标或回复，不直接执行工具'});
        this.say(message.player,'这次消息未形成有效目标，尚未提交新操作。'); return;
      }
      if (isOpenGoal(current) && current.owner.toLowerCase() !== message.player.toLowerCase()) {
        this.say(message.player, '正在处理另一位玩家的目标，请等它结束。'); return;
      }
      clearTimeout(this.wakeTimer);
      if (isOpenGoal(current) && route.mode === 'amend') {
        current.revision++; current.messages.push({ id: message.id, text: message.text, at: message.receivedAt });
        current.objective = route.objective; current.criteria = route.criteria; current.assumptions = route.assumptions;
        this.renewExecutionWindow(current,'player_amend',current.status==='paused');
        current.remaining = route.criteria.map(c => c.text); current.status = current.pendingBatch ? 'reconciling' : 'active'; current.assessment = undefined;
        current.noProgress = 0; current.reconciliationFailures = 0;
      } else {
        if (isOpenGoal(current)) { current.status = 'cancelled'; this.record('control', { reason: '玩家替换目标', messageId: message.id }); }
        const pending = this.state.pendingRequest?.player === message.player ? this.state.pendingRequest : undefined;
        this.state.goal = { id: randomUUID(), owner: message.player, revision: 1, originalRequest: pending?.text ?? message.text,
          messages: [...(pending ? [{ id: pending.id, text: pending.text, at: pending.at }] : []),
            { id: message.id, text: message.text, at: message.receivedAt }], objective: route.objective,
          criteria: route.criteria, assumptions: route.assumptions, remaining: route.criteria.map(c => c.text),
          status: 'active', createdAt: Date.now(), deadline: Date.now() + (this.options.lifetimeMs ?? 86_400_000),
          budget: this.executionBudget(),
          noProgress: 0, lastState: '' };
      }
      this.state.pendingRequest = undefined;
      if (this.activeBatch) this.scheduler.cancel(this.activeBatch, '玩家修订目标');
      this.epoch++; this.record('memory', { reason: route.mode, messageId: message.id });
      this.say(message.player, '收到，我会按完整要求推进。');
    } catch (error) {
      if (error instanceof Error && error.message === 'STALE_AGENT_TURN') {
        // Newer messages invalidate model output, but retain the earlier request for rerouting.
        if (controlGeneration === this.controlGeneration && !this.closed) this.inbox.unshift(entry);
        return;
      }
      if (!this.storageFailed) this.say(message.player, error instanceof Error && error.message === 'BRAIN_PROMPTS_NOT_REVIEWED'
        ? '大脑配置等待管理员审阅启用；停止和暂停仍可使用。'
        : '消息处理暂时失败，没有提交新操作；请稍后重试。');
      if (this.storageFailed) throw error;
    } finally { entry.resolve(); }
  }
  private async step() {
    const epoch = this.epoch, goal = this.state.goal!;
    this.observe(); goal.noProgress++;
    if (goal.noProgress > 6) { this.pause('连续尝试未产生有效进展，已暂停；剩余：' + goal.remaining.join('；')); return; }
    const decision = await this.call('decision', this.context({trigger:'goal_step'}), epoch);
    if (['query','read_evidence','propose','plan'].includes(decision.kind)) { await this.executeDecision(decision, epoch); return; }
    if (decision.kind === 'finish') { this.applyAssessment(decision.assessment); return; }
    if (decision.kind === 'control') { this.control(decision.action,goal.owner); return; }
    if (decision.kind === 'respond') { goal.status='waiting_player'; this.say(goal.owner,decision.text); return; }
    if (decision.kind === 'goal') { this.record('error',{code:'GOAL_DECISION_SCOPE',reason:'自主执行轮不能改写玩家目标'}); return; }
    if (decision.kind === 'reconcile') {
      const pending = goal.pendingBatch;
      const submitted = this.state.events.find(e => e.kind === 'submitted' && (e.data as any)?.id === pending?.id);
      const batch = this.state.events.find(e => e.kind === 'batch' && (e.data as any)?.id === pending?.id);
      const fresh = this.state.events.filter(e => e.goalId === goal.id && e.revision === goal.revision
        && e.at >= Math.max(submitted?.at ?? goal.createdAt, batch?.at ?? 0)
        && (e.kind === 'observation' && (e.data as any)?.status === 'succeeded'
          || e.kind === 'query' && (e.data as any)?.result?.status === 'succeeded'
          && ['snapshot', 'observe_inventory', 'observe_targets', 'inspect_block', 'find_blocks', 'verify'].includes((e.data as any)?.query?.type)));
      const valid = decision.evidenceIds.every(id => this.state.events.some(e => e.id === id && e.goalId === goal.id
        && ['observation', 'query', 'batch'].includes(e.kind)));
      if (pending && !this.controller.busy && valid && decision.evidenceIds.some(id => fresh.some(e => e.id === id))) {
        goal.pendingBatch = undefined; goal.reconciliationFailures = 0; goal.status = 'active'; this.record('memory', { reconciliation: decision });
      } else {
        goal.reconciliationFailures = (goal.reconciliationFailures ?? 0) + 1;
        this.record('error', { reason: '引用必须属于当前目标；允许历史事实/批次作为辅助，但至少需要一条当前修订、操作结束后的成功世界观察',
          code: 'RECONCILIATION_EVIDENCE_INVALID', eligibleFreshEvidenceIds: fresh.slice(-4).map(e => e.id) });
        if (goal.reconciliationFailures >= 3) this.pause('连续三次对账证据无效，已暂停并保留未确认操作，避免重复执行。');
      }
      return;
    }
    if (decision.kind === 'ask') { goal.status = 'waiting_player'; this.record('control', decision); this.say(goal.owner, decision.question); return; }
    if (decision.kind === 'blocked') { this.pause(decision.reason); return; }
    if (decision.kind !== 'wait') return;
    goal.noProgress = Math.max(0, goal.noProgress - 1);
    goal.status = 'waiting_world'; goal.wakeAt = Date.now() + decision.milliseconds; this.record('control', decision);
    this.wakeTimer = setTimeout(() => {
      if (this.closed || this.storageFailed || this.state.goal?.id !== goal.id || goal.status !== 'waiting_world') return;
      goal.status = 'active'; this.kick();
    }, decision.milliseconds);
  }
  /** One model decision produces at most one query, batch or bounded stage. */
  private async executeDecision(decision: AgentDecision, epoch: number) {
    const goal = this.state.goal!;
    const version = (this.state.events.filter(e=>e.kind==='observation').at(-1)?.data as any)?.data?.version;
    const allowed: string[] = availableOperations(version,this.options.capabilities).filter(t=>t!=='say');
    if (decision.kind==='read_evidence') {
      const records=decision.ids.map(id=>this.state.events.find(e=>e.id===id && e.goalId===goal.id));
      if(Buffer.byteLength(JSON.stringify(records))>12000) {
        this.record('error',{code:'EVIDENCE_OUTPUT_TOO_LARGE',ids:decision.ids,reason:'缩小读取数量或重新执行范围更小的查询'});return;
      }
      this.record('memory',{reason:'read_evidence',records});return;
    }
    if (decision.kind==='query') {
      const result=publicEvidence(this.actions.query(decision.query));
      const entry={query:decision.query,result};
      const novel=(result as any)?.status==='succeeded' && !this.state.events.some(e=>e.goalId===goal.id
        && e.kind==='query' && signature(stableFacts(e.data))===signature(stableFacts(entry)));
      this.record('query',entry);
      if ((result as any)?.status!=='succeeded') this.record('error',{code:'QUERY_FAILED',query:decision.query,result});
      if(decision.query.type==='crafting_options' && (result as any)?.status==='succeeded') {
        this.state.craftingRequests=[...(this.state.craftingRequests??[]).filter(r=>signature(r.query)!==signature(decision.query)),
          {goalId:goal.id,query:decision.query}].slice(-8);this.save();
      }
      if(novel)goal.noProgress=0;
      return;
    }
    if (decision.kind!=='propose' && decision.kind!=='plan') return;
    if(goal.pendingBatch) {this.record('error',{code:'PENDING_BATCH',reason:'先查询并对账未确认操作，不能提交新写操作'});return;}
    if(goal.budget.calls<1) {this.pause('本轮模型额度不足以在执行后核对结果，进度已保存。');return;}
    if(decision.kind==='plan') {
      if(decision.plan.nodes.some(n=>n.kind==='act'&&!allowed.includes(n.operation.type))) {
        this.record('error',{code:'OPERATION_UNAVAILABLE',reason:'阶段包含当前未开放的操作'});return;
      }
      this.record('proposal',{decision});await this.executeStage(decision.plan,epoch);return;
    }
    if(decision.operations.some(op=>!allowed.includes(op.type))) {
      this.record('error',{code:'OPERATION_UNAVAILABLE',operations:decision.operations});return;
    }
    const current=this.state.events.filter(e=>e.kind==='observation').at(-1)?.data as any;
    const invalid=this.options.validateOperations?.(decision.operations)
      ?? (current?.status==='succeeded'?handPrerequisite(decision.operations,current.data):'当前观察不可用，先重新观察');
    if(invalid) {this.record('error',{code:'OPERATION_PREFLIGHT',operations:decision.operations,reason:invalid});return;}
    if(goal.budget.operations<decision.operations.length) {this.pause('本轮动作额度不足，进度已保留。');return;}
    this.record('proposal',{decision});
    await this.runBatch(decision.operations,epoch);
    this.check(epoch);
  }
  private async executeStage(plan:StagePlan,epoch:number) {
    const goal=this.state.goal!;
    const stage:StageState={id:randomUUID(),revision:goal.revision,plan,cursor:plan.entry,status:'running',
      deadline:Math.min(goal.deadline,Date.now()+Math.min(plan.maxDurationMs,goal.budget.activeMs)),
      transitions:0,operations:0,outputs:{},counts:{},frames:{}};
    goal.stage=stage;this.record('memory',{reason:'stage_validated',stageId:stage.id,plan});
    let guardFailure:string|undefined;
    const unsubscribeGuards=plan.guards.length?this.options.subscribeWorld?.(()=>{
      if(guardFailure || stage.status!=='running' || this.state.goal!==goal || goal.revision!==stage.revision)return;
      try {
        for(const guard of plan.guards) {
          const result=this.actions.query({type:'verify',condition:guard});
          if(result.status!=='succeeded'||(result.data as any)?.value!==true) {
            guardFailure='STAGE_GUARD_UNMET: 世界事件使阶段约束失效或未知';break;
          }
        }
      }catch{guardFailure='STAGE_GUARD_OBSERVATION_FAILED';}
      if(guardFailure){this.scheduler.stop(guardFailure);this.controller.stop(guardFailure);}
    }):undefined;
    try {
      await runStage(stage,{
        check:()=>{this.check(epoch);if(guardFailure)throw new Error(guardFailure);if(this.state.goal!==goal || goal.revision!==stage.revision || goal.status!=='active') throw new Error('STALE_AGENT_TURN');},
        save:()=>this.save(),
        query:query=>{
          const result=publicEvidence(this.actions.query(query)) as {status:string;data?:unknown;error?:unknown};
          this.record('query',{query,result,stageId:stage.id,node:stage.cursor});return result;
        },
        act:async(operation,deadline)=>{
          this.check(epoch);
          if(goal.pendingBatch || this.controller.busy) throw new Error('STAGE_PENDING_OPERATION');
          if(goal.budget.operations<=0) throw new Error('STAGE_GOAL_OPERATION_LIMIT');
          const snapshot=this.actions.query({type:'snapshot',radius:8});
          if(snapshot.status!=='succeeded') throw new Error('STAGE_OBSERVATION_UNAVAILABLE');
          const version=(snapshot.data as any)?.version;
          if(!availableOperations(version,this.options.capabilities).includes(operation.type)) throw new Error('STAGE_OPERATION_UNAVAILABLE');
          const invalid=this.options.validateOperations?.([operation]) ?? handPrerequisite([operation],snapshot.data);
          if(invalid) throw new Error(invalid);
          await this.runBatch([operation],epoch,deadline);
          this.check(epoch);
          const batch=this.state.events.filter(e=>e.kind==='batch' && e.goalId===goal.id).at(-1)?.data as TaskSnapshot|undefined;
          const action=batch?.stepResults?.[0]?.partialEffects?.at(-1);
          if(batch?.state!=='completed' || goal.pendingBatch) return {status:'failed',error:action?.error ?? batch?.state};
          // Persist the action receipt with the next cursor; native effects are never inferred from the plan.
          return {status:'succeeded',data:publicEvidence(action?.data ?? batch.stepResults?.[0]?.data)};
        },
      });
      this.observe();
      this.record('memory',{reason:'stage_finished',stageId:stage.id,status:stage.status,summary:stage.reason,
        operations:stage.operations,transitions:stage.transitions});
    } catch(error) {
      if(this.closed || this.storageFailed || error instanceof Error && error.message==='STALE_AGENT_TURN') throw error;
      this.record('error',{code:'STAGE_INTERRUPTED',stageId:stage.id,node:stage.cursor,reason:stage.reason,
        failedNode:plan.nodes.find(n=>n.id===stage.cursor),completedOperations:stage.operations-(stage.pendingNode?1:0),
        requiresReconciliation:Boolean(goal.pendingBatch)});
      // Failed native work retains pendingBatch for the existing reconciliation protocol.
      this.observe();
    } finally {unsubscribeGuards?.();}
  }
  private async runBatch(operations: BasicOperation[], epoch: number, stageDeadline?:number) {
    this.check(epoch);
    const goal = this.state.goal!;
    if (this.controller.busy) return;
    const id = `v2-${randomUUID()}`, revision = goal.revision;
    goal.budget.operations -= operations.length;
    goal.pendingBatch = { id, revision, operations };
    goal.reconciliationFailures = 0;
    this.record('submitted', goal.pendingBatch); // Durable intent BEFORE any write.
    this.check(epoch);
    this.scheduler.submit({ id, goal: goal.objective, deadline: Math.min(goal.deadline,stageDeadline ?? Infinity, Date.now() + Math.min(120_000, goal.budget.activeMs)),
      steps: operations.map((operation, i) => ({ id: `op-${i}`, actions: [{ type: 'operate', operation }], idempotent: false })),
      metadata: { goalId: goal.id, revision, owner: goal.owner, agent: 'v2' } });
    this.activeBatch = id;
    if (this.state.events.filter(e => e.goalId === goal.id && e.kind === 'submitted').length === 1) this.say(goal.owner, '开始执行：' + goal.objective);
    try {
      while (!this.closed) {
        const task = this.scheduler.get(id);
        if (!task || terminal(task.state)) break;
        let done = false, failure: unknown;
        const work = this.scheduler.runUntilIdle?.(1).then(() => { done = true; }, error => { done = true; failure = error; });
        if (!work) throw new Error('SCHEDULER_RUN_UNAVAILABLE');
        while (!done && !this.closed) {
          if (this.inbox.length) await this.consumeMessage();
          await Promise.race([work, delay(25)]);
        }
        if (failure) throw failure;
        if (this.state.goal?.id !== goal.id || goal.revision !== revision || !['active', 'reconciling'].includes(goal.status)) this.scheduler.cancel(id, '目标版本改变');
        if (this.controller.busy) await delay(25);
      }
      if (this.closed) return;
      const task = this.scheduler.get(id);
      // Preserve the original scope even if the player replaced the goal during an action.
      this.recordBatch(goal, revision, task);
      if (this.state.goal?.id === goal.id && task?.state === 'completed' && !this.controller.busy) {
        goal.pendingBatch = undefined; this.save();
      }
    } finally { this.activeBatch = undefined; }
  }
  private recordBatch(goal: AgentGoal, revision: number, task: TaskSnapshot | undefined) {
    const event: AgentEvent = { id: randomUUID(), at: Date.now(), goalId: goal.id, revision, kind: 'batch', data: publicEvidence(task) };
    this.state.events.push(event); this.save();
    this.options.diagnostics?.emit('feedback', 'info', 'V2 批次结果（不是总目标完成）', event);
  }
  private applyAssessment(result: Assessment) {
    const goal=this.state.goal!;
    if(goal.pendingBatch || this.controller.busy) {this.record('error',{code:'PENDING_BATCH',reason:'仍有未确认操作，不能结算'});return;}
    const fresh=this.state.events.filter(e=>e.goalId===goal.id&&e.revision===goal.revision&&e.kind==='observation').at(-1);
    if((fresh?.data as any)?.status!=='succeeded') {this.record('error',{code:'OBSERVATION_UNAVAILABLE',reason:'缺少当前成功观测，不能结算'});return;}
    const evidence=this.state.events.filter(e=>e.goalId===goal.id&&['observation','query','batch'].includes(e.kind));
    const ids = new Set(result.verdicts.map(v => v.criterionId));
    const completeCoverage = ids.size === goal.criteria.length && ids.size === result.verdicts.length && goal.criteria.every(c => ids.has(c.id));
    const factual = (event: AgentEvent) => {
      const data = event.data as any;
      if (event.kind === 'observation') return data?.status === 'succeeded';
      if (event.kind === 'query') return data?.result?.status === 'succeeded'
        && !['recipe_lookup', 'recipe_evaluate', 'requirements_expand', 'operation_schema','crafting_options','container_memory'].includes(data?.query?.type);
      return event.kind === 'batch' && data?.stepResults?.some((step: any) => step.partialEffects?.length);
    };
    const validEvidence = result.verdicts.every(v => v.verdict !== 'met' || v.evidenceIds.length > 0
      && v.evidenceIds.every(id => evidence.some(e => e.id === id))
      && v.evidenceIds.some(id => evidence.some(e => e.id === id && factual(e))));
    goal.assessment = result;
    goal.remaining = [...result.verdicts.filter(v => v.verdict !== 'met').map(v => goal.criteria.find(c => c.id === v.criterionId)?.text ?? v.explanation), ...result.omittedRequirements];
    if (!completeCoverage || !validEvidence) goal.remaining = goal.criteria.map(c => c.text);
    const passed = completeCoverage && validEvidence && !result.omittedRequirements.length && result.verdicts.every(v => v.verdict === 'met');
    this.record('assessment', { ...result, protocolAccepted: completeCoverage && validEvidence, passed });
    if (passed) { goal.status = 'completed'; this.save(); this.say(goal.owner, result.summary); }
    else { goal.status = 'active'; this.save(); }
  }
}
