# Development instructions

Use Python 3.12+ and Node 22+. Work from the repository root.

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
