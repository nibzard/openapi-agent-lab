# idem-runtime

A labeled synthetic runtime pack for idempotency keys and virtual
expiry. It models no real service and makes no fidelity claim. The
pack exists so the runtime has one small world where the observable
idempotency behaviors can be checked end to end:

- A repeated create with the same `Idempotency-Key`, body, and
  principal replays the sealed response and never runs the behavior
  again.
- The same key with a different body answers `409`.
- Two verified principals (bearer and basic) hold separate caches.
- An entry expires after one hour of virtual time; advancing the
  clock, not sleeping, moves it.
- A response committed before a transport cut replays on retry.

The checks live in `packages/testkit/src/runtime-corpus.test.ts`.
The pack ships a small portable corpus under `corpora/core.yaml` for
the black-box subset of the same behaviors.
