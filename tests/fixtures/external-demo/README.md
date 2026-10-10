# external-demo

The external authoring template: one resource with one transition.

- `contract/openapi.json` — the counter API with bearer security.
- `behavior/index.ts` — the scenario backend; it owns the counters,
  moves the value by exactly one per increment, and emits the
  `counter.created` and `counter.incremented` events.
- `corpora/core.yaml` — four cases: create and read, the transition,
  a reset that clears the world, and the missing-resource boundary.
- `evals/smoke/` — one eval with a rubric and a scripted participant.
- `fidelity/claims.json` — the fidelity declaration; every claim is
  synthetic because the pack models no real service.

Validate it, run its corpus, serve and fork its world, or copy it as
a starting point. The tutorial in
`docs/tutorial-external-pack.md` walks the full loop with the
installed executable.
