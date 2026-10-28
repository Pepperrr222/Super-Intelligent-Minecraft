# Development instructions

Use Python 3.12+ and Node 22+. Work from the repository root.

## 项目协作约定

- 用户发现或反馈问题后，遵循“先讨论，再设计，最后由用户敲定修改”的流程。不要把问题描述自动视为立即修改实现的授权。
- 讨论阶段可以只读排查和收集证据，先澄清现象、预期行为、影响范围与根因；未经用户明确确认，不修改实现或运行配置。
- 设计阶段说明问题所属的类别、共同原因、方案取舍、拟改范围与验证方式。等用户明确敲定方案后，再在批准范围内实施；若范围或关键设计发生变化，重新讨论确认。
- 每次修改都应尽量解决一类问题，而不只是当前案例。优先改进共同契约、状态管理、能力边界或错误处理，避免按某条指令、物品或测试案例硬编码补丁。
- 以项目长期收益为判断标准，考虑架构一致性、可维护性、可扩展性和回归风险；采用足够解决问题的设计，避免无依据的过度抽象。验证应覆盖同类问题及相关边界。

## Implementation rules

- Read docs/ARCHITECTURE.md and docs/PROTOCOL.md before changing cross-process behavior.
- Keep domain independent of model, game and database I/O. Compose adapters in app.
- Mineflayer owns game actions; Python owns planning, budgets and completion verification.
- Never complete a task from model text or an action submission acknowledgement.
- Stop bypasses model calls. Preserve partial effects and reject stale continuations.
- B0 must not retrieve persistent experience. Unverified explanations cannot become skills.
- Keep keys, local config, auth caches, world saves and runtime evidence out of Git.
- Reserve Node stdout for JSONL; diagnostics go to stderr.
- Run `python scripts/dev.py test` for behavior changes and the demo for cross-layer changes.
- Do not describe offline mocks as real-server or model acceptance tests.
- Backend capabilities need parameters, effect evidence, cancellation limits and tests.

Current milestone: vanilla execution. Explicit correction/clarification and composite delta goals are implemented. Complex mod machines and automatic B2/B3 execution remain future work. Real-server acceptance uses scripts/live_acceptance.py; rules/scripted tests must not be described as cloud-LLM evaluation.
