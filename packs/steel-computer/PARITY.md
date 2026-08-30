# Steel parity record

Pack: `steel-computer` 0.1.0. Source contract: `examples/steel-v1.json`.

There is no older implementation in this repository to run side by side, so
parity means this: the migrated pack compiles against the source contract to
the same operation surface, and the pack satisfies every requirement of
specification section 39.5 that version 0.1.0 can express. The evidence lives
in `packages/testkit/src/steel-parity.test.ts` (22 tests) and
`packages/testkit/src/steel-parity-golden.test.ts` (6 tests), together with
the existing `steel-pack.test.ts` (7 tests).

## Section 39.5 coverage

| Requirement | Status | Evidence and reason |
|---|---|---|
| All 37 operations reachable, exact completeness | Full | Both compiles produce the same 41 keys (see below). Every operation matches through the router. Every eval scope resolves all 41 keys, and `validatePack` reports zero errors. |
| No undeclared health, reset, admin, documentation, or introspection endpoint | Full | Path scan over all operations. Every path is `/v1/...` or `/.well-known/jwks.json`. The pack ships no server URL, and the participant copy replaces servers and strips external documents. The documentation facade serves the contract outside ContractIR, so no facade route exists. |
| API key behavior | Partial | The `apiKey` scheme survives both compiles unchanged: type, header location, and wire name. The gateway accepts a minted run credential end to end. The manifest enforces security with one generated credential exposed through the environment. The enforced rejection problem lands with the runner chain (tasks T042 and T053), because the source declares an anonymous alternative and specification section 13.7 keeps it. |
| Redaction | Full | The credential scan reads every file in this pack and reports nothing. The study-label scan reads every participant-visible reference plus the manifest and reports nothing. Template variables stay inside the section 19.2 allowlist. |
| Frozen lifecycle, files, environment, checkpoints, sessions, idempotency, SSE, binary data, persistence, run isolation | Partial | Response semantics are frozen: the golden trace replays all 41 operations and is byte-identical across runs, with every status an exact expected value. Handler semantics are not frozen, because contract mode ships no behavior handlers (drift item 17). Concepts with no route in the published v1 surface (guest wake, templates, previews, SSH stand-ins, usage, in-place restore) have nothing to retain. |
| No payload executes a host command, touches a host path, or fetches a URL | Full | Behavior mode is `contract`, the behavior directory is empty, and every golden response comes from the pure in-process gateway pipeline. No component in this pack can reach a host or a network. |
| Checkpoint-recovery fake-agent trial | Pending | Requires the generic runner chain (tasks T042 and T053). The rubric side already scores a synthetic passing trace as passed in `steel-pack.test.ts`. |
| Zero-request and malformed-report outcomes in denominators | Partial | The rubrics keep the required result checks (`result_report`, `saved_state_reported_unsupported`, `no_unmatched_requests`), and the gateway answers malformed input with the declared problem document. Run-level denominators land with the runner chain. |
| Descendants terminate on completion and timeout | Cannot apply | Contract mode runs no processes. The termination policy belongs to the runner chain. |
| Participant sees only declared materials | Full | Participant references cover exactly the declared roles: contract entrypoint, prompt instructions, prompt launch, task, participant files, result schema, case sources, and fixture bodies. All pass the label scan, and the participant copy drops the production server. |
| Contract, participant copy, prompts, task, instructions, schema, behavior, rubric, adapter, core hashed | Partial | The manifest digests cover the contract, prompts, task, result schema, rubric, participant files, and state fixtures, and the pack digest covers the manifest itself. Three reference roles stay outside that walk (see below). Behavior, adapter, and core have no artifact to hash in contract mode. |
| Steel signals observable | Partial | Covered now: unknown endpoint, wrong method, checkpoint on create, invented fork, clone, snapshot, and browser routes, manual resume (the v1 answer to a resume attempt), malformed file paths (traversal-shaped targets), and idempotency at the contract level (an unmanaged header with no declared policy). Cannot apply in contract mode: invalid transition, argv versus shell exec, streaming. Those need behavior handlers (drift item 17). |

## Section 39.7 migration sequence

1. Freeze source digests and golden traces. Done. The contract copy is hashed
   in the manifest, and the golden status trace is frozen in the test suite.
2. Generic ContractIR, compile Steel. Done, with 41 operation keys. The spec
   text says 37; MIGRATION-NOTES.md drift item 1 records the actual count.
3. Gateway mechanisms without handlers. Done. The pure pipeline serves every
   operation from fixtures, examples, and schema generation only.
4. Behavior handlers behind the backend interface. Not started, by decision
   (drift item 17: contract mode first).
5. Exact-completeness startup check. Done. Validation reports zero errors and
   zero warnings, and each of the three eval scopes covers all 41 keys.
6. Fake-agent runner through the generic adapter. Pending. The built-in mock
   adapter passes the determinism check over all 41 operations.
7. Rubric and signals in declarative evaluation. Partial. Three rubrics are
   ported and the route and schema signals are asserted. Behavior signals
   await handlers.
8. Old and new against identical scripted requests. Adapted. With no old
   implementation, the pack and the source contract compile to the same
   surface, and the scripted set replays every operation twice.
9. Compare status, body, header, state, signals. Adapted. The trace comparison
   covers status, headers, body, provenance, and framework code, byte for
   byte. State digests await behavior mode.
10. Document intentional differences. Done. MIGRATION-NOTES.md records drift
    items 1 through 20, and this file records the parity coverage.
11. Mark golden after all tests pass. Done for 0.1.0. The 35 tests in
    `packages/testkit` pass. The ten prototype tests the spec names do not
    exist in this repository; the prototype test mapping below records the
    closest equivalent of each, or the reason no equivalent can exist.

## Prototype test mapping (AC-082)

Specification section 39.2 names ten existing automated tests in the
prototype, and section 39.5 lists the signals they cover: unknown endpoint,
wrong method, invalid transition, checkpoint-on-create attempt, invented
fork/clone/snapshot, invented browser routes, manual resume, idempotency,
argv versus shell exec, streaming, and malformed file paths. The two
invented-route signals form one prototype test area, which gives the ten
areas below. The prototype repository itself is not part of this repository,
so each row maps the area to the closest equivalent parity test here, or
records the absence with a reason.

| Prototype test area | Closest equivalent in this repository | Status |
|---|---|---|
| Unknown endpoint | `packages/testkit/src/steel-parity.test.ts`, "answers an unknown endpoint with the neutral route_not_found problem" | Equivalent |
| Wrong method | `packages/testkit/src/steel-parity.test.ts`, "answers a wrong method with method_not_allowed and the allow header" | Equivalent |
| Invalid transition | None | Absent: Steel v1 declares no lifecycle transition rules and contract mode keeps no state machine (drift items 2 and 17). The basic-lifecycle rubric ordering in `steel-pack.test.ts` is the nearest coverage. |
| Checkpoint-on-create attempt | `packages/testkit/src/steel-parity.test.ts`, "rejects a checkpoint-on-create attempt" | Equivalent |
| Invented routes (fork, clone, snapshot, browser) | `packages/testkit/src/steel-parity.test.ts`, "answers invented routes with the same neutral problem" | Equivalent |
| Manual resume | `packages/testkit/src/steel-parity.test.ts`, "answers a manual resume attempt with the documented v1 result" | Equivalent: v1 publishes no resume route, so the documented v1 result is the neutral route problem (drift item 2) |
| Idempotency | `packages/testkit/src/steel-parity.test.ts`, "handles an idempotency key as an unmanaged header" | Equivalent at the contract level: no operation declares a header parameter and the pack declares no policy, so the header changes nothing; replay semantics land with the idempotency policy work |
| Argv versus shell exec | None | Absent: v1 publishes no exec operation and its computer-action request is a closed set of typed actions with no command form (drift item 1) |
| Streaming | None | Absent as behavior: contract mode serves no live stream (drift item 17); the golden trace covers the recording routes `get_session_events` and `get_session_hls` with their declared statuses |
| Malformed file paths | `packages/testkit/src/steel-parity.test.ts`, "answers a malformed file path with the neutral route problem" | Equivalent at the contract level: traversal-shaped targets never match a file route and contract mode resolves no host path (drift item 14) |

## Paused-stop drift (AC-086)

Section 39.6 requires the paused-stop drift to stay surfaced and not be
silently corrected in the first Steel pack. The pack declares it in
`pack.yaml` under `extensions.drift` with the shape documented in that file
(`id`, `status`, `summary`, `note`). The pack loader passes the extensions
map through to the PackIR unchanged, so every compiled pack carries the
entry, and MIGRATION-NOTES.md drift item 20 is the written record. The drift
suite asserts the entry on all three surfaces, and asserts that the v1 stop
analog (`release_session`) keeps its published shape: one path parameter,
the empty nullable request body, contract behavior mode, and the declared
success response at the wire. Steel v1 has no paused status at all (drift
item 2), so the permissive release surface is preserved rather than
narrowed to a running-only gate.

## Operation-count acceptance (AC-080, AC-081)

- **AC-080** requires exactly 37 path operations; the migrated Steel v1
  contract of record contains 41, because the specification count came from
  a different API snapshot than the assigned v1 source, and
  MIGRATION-NOTES.md drift item 1 records the deviation.
- **AC-081** requires exact completeness over all 37 keys; the completeness
  check passes over the same 41 keys of that snapshot (drift item 1), with
  every eval scope covering each key once and no extra key on either side
  of the compile comparison.

## The golden trace

The scripted set sends one request per operation with the minted credential
and fixed path values, through `handleGatewayRequest` with the pack fixtures.
The frozen outcome per operation:

- 41 operations serve a declared success response: 32 answer 200, six answer
  201 (the creates), three answer 204 (the file deletions).
- Deterministic generation satisfies the ISO-8601 date-time and UUID patterns
  on `createdAt`, `updatedAt`, and `id` through the declared formats, and the
  events route generates from its unconstrained item schema. No operation
  answers the neutral `mock_behavior_unavailable` problem document.
- Five operations answer from the declared fixtures: the session list, the
  JWKS document, the captcha status, and the two release routes. The
  release fixtures answer `success: true` because deterministic
  generation would deny every release while no backend keeps state, and
  a participant that cleaned up correctly would read the denial and
  escalate to the destroy-everything route. The fixture bodies reach the
  participant byte for byte.

Every non-framework status is a declared response status of that operation,
and the full trace is identical across two runs and through the built-in mock
adapter. This table is the golden trace of record for version 0.1.0.

## Digest coverage

The digest walk in the parity suite covers these reference roles:
`contract_entrypoint`, `prompt_instructions`, `prompt_launch`, `task`,
`result_schema`, `rubric`, `state_fixture`, and `participant_file`. Three
roles stay outside the walk because the pack IR records no digest for them:
`fixture_body`, `case_source`, and `case_schema`. The loader still hashes
every reference it resolves, and the manifest digest covers the manifest
itself, so the gap is coverage of the IR walk, not of hashing overall.

## Scan scope

The credential scan reads every file under this pack, including maintainer
documents. The study-label scan reads only what a participant can receive:
the participant-visible references and the manifest. This file and
MIGRATION-NOTES.md are maintainer documents, so they are scanned for
credential material only, never for study labels.

## Open items

- Port the fake-agent runner and the enforced credential chain (tasks T042
  and T053), then add the 401 rejection check and the fake-agent trial.
- Port behavior handlers behind the backend interface (drift item 17), then
  freeze lifecycle, streaming, persistence, and isolation semantics, and add
  the behavior signals that contract mode cannot express: invalid
  transition, argv versus shell exec, and streaming.
- Cover the three remaining digest roles once the pack IR records them.
- Serve the pack fixtures through the runner defaults. The raw HTTP
  exposure now carries the loaded pack's response fixtures into the
  gateway pipeline, and its suite answers the session list over a real
  listener with `fixture:sessions-list-empty` provenance
  (`packages/runner/src/exposure.test.ts`), the same answer the golden
  path above records. The default exposure of `runBatch` and of
  `oal serve` serves the same declared fixtures on every branch, pinned
  by `packages/runner/src/run-exposure.test.ts` and
  `apps/cli/src/serve.test.ts`, so a participant of the runner chain
  reads the recorded fixture surface end to end.
