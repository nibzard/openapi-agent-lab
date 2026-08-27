# Steel Computer migration notes

Version 0.1.0 migrates the real Steel v1 API description
(`examples/steel-v1.json` in the repository root) into the first
built-in pack. Per the locked decision in SPEC section 8, item 15, the
migration happens before any semantics correction: the historical
contract is preserved as published, every drift is documented here, and
each fix waits for a later pack version.

## What was migrated

- `contract/openapi.json` is a byte-for-byte copy of
  `examples/steel-v1.json` with one exception: the `servers` key is
  removed. See drift item 15. The copy declares 26 paths, 41
  operations, and 43 schemas.
- `pack.yaml` declares the pack, its contract wiring, prompt sets,
  evals, scenarios, and fixtures.
- `prompts/diagnostic/` and `prompts/naturalistic/` hold the two prompt
  sets of SPEC section 19.4.
- `evals/` holds three rubrics; `tasks/` and `schemas/` hold the task
  templates, case data, and result schemas they reference.

## Preserved drift

Each item below is visible in the shipped contract or rubrics. None of
them was corrected, per the locked decision.

1. **Contract generation gap.** SPEC section 39 describes a Steel v2
   "computer" API of 37 operations (computers, checkpoints, pause,
   resume, restore, SSH stand-ins). The assigned input is the real
   Steel v1 browser-session API of 41 operations, and the task brief
   names it the source of truth. All 41 v1 operations are kept. The
   checkpoint-recovery rubric maps the SPEC 26.3 example onto the v1
   operations that exist: seed the workspace with `upload_file`, prove
   the bytes with `download_file`, overwrite them, recover the seed
   bytes by a third upload, then release and observe the released
   status. The `pauseComputer` step of the example has no v1
   equivalent, so the flow ends at the released observation.
2. **No pause or resume.** Steel v1 has no pause or resume operations,
   and `SessionResponse.status` enumerates only `live`, `released`,
   and `failed`. The basic-lifecycle eval therefore scores a
   create, live read, release, released read flow instead of the SPEC
   create, pause, resume flow.
3. **No documentation facade.** The platform documentation facade does
   not exist yet, so no `documentation.exchange` events are recorded.
   The `docs_served` check of the documentation-discovery rubric is a
   universal check over an empty stream and passes vacuously. It
   becomes restrictive once the facade ships.
4. **Anonymous access alternative.** The contract declares
   `security: [{"apiKey": []}, {}]`. The empty requirements object
   makes anonymous access a valid alternative to the `steel-api-key`
   header. The pack sets `security.enforce: true` with one generated
   credential, so a run may be stricter than the published contract.
5. **operationId casing drift.** Thirty-seven operation ids are
   snake_case (`create_session`), but the four profile operations are
   lower camelCase (`createProfile`, `listProfiles`, `updateProfile`,
   `getProfile`). The rubric expressions quote the mixed forms exactly.
6. **Destructive collection route.** `POST /v1/sessions/release`
   (`release_all_sessions`) releases every session in the account. It
   is a POST against a sub-path, not a DELETE against the collection.
   The basic-lifecycle rubric caps its use at zero because the scoped
   route `POST /v1/sessions/{id}/release` exists.
7. **Release responds 200 with a body.** Both release operations
   respond `200` with `ReleaseSessionResponse` (`success`, `message`)
   instead of `204`. The rubric step matches status 200 exactly.
8. **ZIP media is unsupported by the compiler.** `download_archive`
   (`GET /v1/sessions/{sessionId}/files.zip`) responds
   `application/zip`. The OpenAPI compiler classifies the media family
   as `other` and emits one `OAL-CAP-MEDIA-UNSUPPORTED` warning. The
   pack compiles with `warnings_as_errors: false`, so the warning is
   preserved rather than fatal. This is the only warning the contract
   produces.
9. **Path parameter naming drift.** Direct session routes use `{id}`
   (`/v1/sessions/{id}`), while nested session routes use `{sessionId}`
   (`/v1/sessions/{sessionId}/files`). The rubric expressions encode
   the inconsistency (`event.request.path_parameters.sessionId` versus
   `event.request.path_parameters.id`).
10. **Placeholder response descriptions.** Every response object in
    the contract carries the description `Default Response`, including
    all 97 error responses. No response documents its own meaning.
11. **No examples.** The contract contains no `example` or `examples`
    blocks. The three response fixtures supply the only sample bodies.
12. **Unrelated versions.** The contract `info.version` is `0.0.1`
    while the pack version is `0.1.0`. The contract number was left as
    published; the pack version follows the pack registry.
13. **Marketing prose in `info.description`.** The description names
    steel.dev, docs.steel.dev, Discord, and pricing claims. It stays in
    the contract copy. The participant copy strips external docs and
    rewrites servers, but the description text itself is unchanged.
14. **Free-form file path parameter.** The `path` parameter of
    `download_file` and `delete_file` is an unconstrained string with
    no pattern or encoding declaration.
15. **Server URL removed.** The source contract published
    `servers: [{url: "https://api.steel.dev"}]`. The pack copy drops
    the `servers` key so no production URL ships with the pack, per
    the sanitization rule of SPEC section 19.3. The run injects the
    mock base URL through `STEEL_BASE_URL`, and
    `participant_copy.replace_servers: true` points the participant
    copy at the mock. Every other byte of the source is unchanged.
16. **`create_session` returns no checkpoint identity.** SPEC section
    39.6 records that v1 must not gain a `checkpoint_id` on creation.
    The contract copy therefore keeps the plain `SessionResponse`.
17. **Behavior mode is contract, not scenario.** The pack ships data
    only, as required for packs in 0.1.0. The 41 behavior handlers of
    the frozen prototype are scenario-backend work. Until they ship,
    `behavior.completeness: exact` with `fallback: none` describes the
    wiring, and the rubrics assert only the trace, not backend state.
18. **Partial fixture coverage.** Three fixtures cover three of the 41
    operations: the empty session list, the empty JWKS document, and
    the idle captcha state. The invariants require a fixture only
    where deterministic state is needed, so the rest of the surface
    waits for the scenario backend of drift item 17.
19. **Captcha endpoints model an external solver.** The captcha routes
    assume a solver service. The idle fixture answers with epoch-zero
    timestamps and an empty task list, which is schema-valid but not
    realistic.
20. **Paused-stop drift (`paused-stop-precondition`).** SPEC section
    39.6 records that the broader Steel contract permits stopping a
    running or paused computer while the prototype handler accepted
    only running. Steel v1 publishes no stop operation; its stop
    analog is `release_session`, and the published contract puts no
    lifecycle precondition on it: the only parameter is the session
    id and the request body is the empty nullable object. The pack
    keeps that broader surface and does not correct the drift
    silently. The release wiring is copied unchanged, behavior mode
    stays `contract` so no handler enforces a running-only rule, and
    the discrepancy is declared in `pack.yaml` under
    `extensions.drift` with the shape documented in that file. The
    loader passes the extensions map to the PackIR, so the entry
    surfaces in pack diagnostics. A correction requires the section
    39.6 sequence: a deliberate version bump, a changelog entry,
    updated behavior tests, a decision confirmed against the Steel
    source-of-truth documents, and a new cohort.

## Migration decisions

These choices resolve questions the specification leaves open. They
are decisions, not drift.

- **Rubric schema references are pack-root relative.** The rubric
  loader rejects any `schema` reference that contains `..`, so the
  SPEC 26.3 style `../../schemas/...` cannot load. References are
  written as `schemas/<name>.schema.json` and resolved against the
  pack root.
- **Participant target names are unique across the pack.** The pack
  invariants compare `participant_files`, task, and instructions
  targets globally, so two prompt sets cannot both write `AGENTS.md`
  and three evals cannot all write `TASK.md`. The sets write
  `AGENTS.md` and `INSTRUCTIONS.md`; the evals write `TASK.md`,
  `lifecycle-task.md`, and `discovery-task.md`. Result schemas follow
  the same rule.
- **Every result and case schema declares Draft 2020-12.** The
  `$schema` keyword is set to
  `https://json-schema.org/draft/2020-12/schema` so schema loading
  produces no draft warnings.
- **The naturalistic instructions stay silent about the contract.**
  SPEC section 19.4 requires the naturalistic set to withhold
  evaluation intent. The set names only the service base URL and the
  credential header; the task file points at the result schema by
  workspace file name instead of by contract terminology.
- **Template variables follow the allowlist.** Only `pack.name`,
  `pack.version`, `api.baseUrl`, `api.contractFile`, `case.name`, and
  `case.input.*` appear in templates, all permitted by SPEC section
  19.2.
- **Preserved drift is declared under `extensions.drift`.** The pack
  schema keeps the `extensions` map free-form and the loader passes it
  to the PackIR unchanged, so a `drift` list there is the diagnostic
  surface of record for preserved discrepancies. Each entry carries
  `id`, `status`, `summary`, and `note`; `status` stays `preserved`
  until a deliberate version bump corrects the drift through the
  section 39.6 sequence.

## Planned for 0.2.0

Fixes land in a new pack version, with a changelog entry and a new
cohort, never as silent edits to 0.1.0.

- Add the scenario backend module with behavior handlers for the 41
  operations, and move `behavior.mode` from `contract` to `scenario`.
- Decide whether release gains a lifecycle precondition once scenario
  state exists, and resolve drift item 20 through the section 39.6
  correction sequence rather than a silent edit.
- Restore the v2 computer semantics of SPEC section 39 (computers,
  checkpoints, pause, resume, restore) as a new contract version or as
  scenario handlers, then restore the original checkpoint-recovery
  rubric shape.
- Unify `operationId` casing on snake_case and the path parameter
  names on one form. Both are contract-breaking changes.
- Replace the `Default Response` placeholders with real descriptions.
- Decide whether the anonymous security alternative stays, then align
  `security.enforce` with the answer.
- Extend fixture coverage, or drop fixtures in favor of handlers once
  scenario mode exists.
- Tighten the rubrics: replace the vacuous `docs_served` check once
  the documentation facade records events, and add state
  postconditions once scenario state exists.
