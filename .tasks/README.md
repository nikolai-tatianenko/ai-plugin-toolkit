# Planning workspace

- [Vision](VISION.md)
- [Implementation plan](plans/CONTEXT-LOOM-IMPLEMENTATION-PLAN.md)
- [Tickets](tickets/README.md)
- [Test plan](test-plan/CONTEXT-LOOM-ACCEPTANCE.md)

Ticket states: planned, in-progress, blocked, implemented, verified. All initial tickets are planned. Implemented does not mean verified or release-ready. Update tickets with changed paths, checks run, results, and remaining limitations.

Automated integration tests are required for complete workflows and adapter boundaries. Mocks are useful for failure tests but do not establish real integration readiness. Real-provider checks must be opt-in, use synthetic data, have cost limits, and report explicit skips when credentials are absent.

Work on feature branches and deliver reviewable PRs; do not merge automatically. Keep changes modular, stage explicit paths, preserve manual edits, and never commit secrets or real conversation history. Add public documentation only for behavior that exists; clearly label proposed APIs and commands.
