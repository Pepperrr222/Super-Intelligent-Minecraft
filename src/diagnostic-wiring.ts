import type { CompanionRuntime } from './runtime.js';
import type { DiagnosticBus } from './diagnostics.js';

export function wireDiagnostics(runtime: CompanionRuntime, bus: DiagnosticBus) {
  const handle = runtime.interaction.handle.bind(runtime.interaction);
  runtime.interaction.handle = message => bus.message(message.player, message.text, () => handle(message));
  const execute = runtime.actions.execute.bind(runtime.actions);
  runtime.actions.execute = (action, options) => bus.span('action', '底层动作', { action }, () => execute(action, options));
  const query = runtime.actions.query.bind(runtime.actions);
  runtime.actions.query = input => {
    try {
      const result = query(input);
      bus.emit('observation', result.status === 'succeeded' ? 'ok' : 'error', '客户端/知识查询', { query: input, result }); return result;
    } catch (error) { bus.emit('observation', 'error', '查询异常', error); throw error; }
  };
  const control = runtime.controller.execute.bind(runtime.controller);
  runtime.controller.execute = command => bus.task(command.taskId, () => bus.span('controller', '步骤执行', command, () => control(command)));
  const submit = runtime.scheduler.submit.bind(runtime.scheduler);
  runtime.scheduler.submit = task => {
    bus.bindTask(task.id);
    try { const result = submit(task); bus.emit('scheduler', 'ok', '任务已入队', { task, result }); return result; }
    catch (error) { bus.emit('scheduler', 'error', '任务入队失败', { task, error }); throw error; }
  };
  const submitAll = runtime.scheduler.submitAll.bind(runtime.scheduler);
  runtime.scheduler.submitAll = tasks => {
    tasks.forEach(task => bus.bindTask(task.id));
    try { const result = submitAll(tasks); bus.emit('scheduler', 'ok', '任务图已入队', { tasks, result }); return result; }
    catch (error) { bus.emit('scheduler', 'error', '任务图入队失败', error); throw error; }
  };
  const runNext = runtime.scheduler.runNext.bind(runtime.scheduler);
  runtime.scheduler.runNext = async () => {
    const result = await runNext();
    if (result) bus.task(result.id, () => bus.emit('scheduler',
      ['failed', 'blocked'].includes(result.state) ? 'blocked' : result.state === 'cancelled' ? 'cancelled' : 'ok',
      '调度状态更新', { state: result.state, currentStep: result.currentStep, totalSteps: result.totalSteps, lastResult: result.lastResult }));
    return result;
  };
  const send = runtime.transport.send.bind(runtime.transport);
  runtime.transport.send = (player, text) => { bus.emit('reply', 'info', '发给玩家的回复', { player, text }); return send(player, text); };
}
