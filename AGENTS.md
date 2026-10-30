# SIM 项目约定

- 此目录是新的 Minecraft Java Agent 实现，现阶段提供 TypeScript 底层动作库。
- 先读 README.md、PROJECT_STATUS.md 和 docs/actions.md；动作结构以 src/schema.ts 为准。
- PROJECT_STATUS.md记录当前事实，docs/roadmap.md记录计划；新增能力或验证结果后同步更新，不把计划标为完成。
- 维护 schema、实现、动作目录和生成的 JSON Schema 一致。
- 所有游戏写操作通过同一个 MinecraftActions / ActionExecutor，保持每个 Bot 单一控制权。
- 每个多步异步动作在继续产生副作用前检查取消；不能提前释放仍在执行的原生操作的控制权。
- 底层不隐藏任务规划、自动重试或目标选择。把这些放到后续技能/调度层。
- 区分请求发出、客户端观测、API 完成与任务成功；不得把模拟测试写成真实服务器验证。
- 检查命令：pnpm build、pnpm test；变更动作参数后运行 pnpm schema。
- 不提交 .auth、.env、node_modules 或登录资料。
