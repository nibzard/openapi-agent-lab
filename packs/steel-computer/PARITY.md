# Steel parity record

Pack: `steel-computer` 0.1.0. Source contract: `examples/steel-v1.json`.

There is no older implementation in this repository to run side by side, so
parity means this: the migrated pack compiles against the source contract to
the same operation surface, and the pack satisfies every requirement of
specification section 39.5 that version 0.1.0 can express. The evidence lives
in `packages/testkit/src/steel-parity.test.ts` (17 tests) and
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
| Steel signals observable | Partial | Covered now: unknown endpoint, wrong method, checkpoint on create, invented fork, clone, snapshot, and browser routes. Cannot apply in contract mode: invalid transition, manual resume, idempotency, argv versus shell exec, streaming, malformed file paths. Those need behavior handlers (drift item 17). |

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
    items 1 through 19, and this file records the parity coverage.
11. Mark golden after all tests pass. Done for 0.1.0. The 30 tests in
    `packages/testkit` pass. The ten prototype tests the spec names do not
    exist in this repository.

## The golden trace

The scripted set sends one request per operation with the minted credential
and fixed path values, through `handleGatewayRequest` with the pack fixtures.
The frozen outcome per operation:

- 27 operations serve a declared success response: 23 answer 200, one answers
  201 (`POST /v1/extensions`), three answer 204 (the file deletions).
- 14 operations answer 501 with the neutral `mock_behavior_unavailable`
  problem document. Thirteen success schemas carry an ISO-8601 date-time
  pattern on `createdAt` or `updatedAt` that deterministic generation refuses,
  and the events route declares no usable type. Contract mode has no response
  value for them (drift items 17 and 18).
- Three operations answer from the declared fixtures: the session list, the
  JWKS document, and the captcha status. The fixture bodies reach the
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
  the behavior signals: invalid transition, manual resume, idempotency, argv
  versus shell exec, and malformed file paths.
- Cover the three remaining digest roles once the pack IR records them.
