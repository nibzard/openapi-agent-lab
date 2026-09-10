# Capability matrix

This matrix records the minimum viable product (MVP) capability set from
specification section 41 and where the implementation provides it. Status
labels follow the specification. The implementation column names the package
that owns the behavior.

## Contract ingestion and execution

| Capability | MVP status | Implementation |
| --- | --- | --- |
| OAS 3.0.x JSON/YAML | Required | `@oal/openapi` loader and compiler |
| OAS 3.1.x JSON/YAML | Required | `@oal/openapi` loader and compiler |
| OAS 2.0, 3.2 | Unsupported | Stable preflight diagnostic in `@oal/openapi` |
| Local internal and relative refs | Required | `@oal/openapi` reference resolver |
| Remote refs | Disabled | Rejected without retrieval in `@oal/openapi` |
| GET, PUT, POST, DELETE, OPTIONS, HEAD, PATCH, TRACE | Required | `@oal/gateway` router |
| Path, query, header, cookie parameters | Required | `@oal/gateway` parameter pipeline |
| JSON, text, form, octet-stream bodies | Required | `@oal/gateway` validation and generation |
| Multipart | Required subset | Text and binary parts; explicit diagnostics |
| XML | Optional or approximated | Capability report only; no DTD support |
| Server-sent events | Required for Steel subset | Planned in `@oal/gateway` |
| WebSocket | Unsupported | Capability diagnostic |
| API key, Basic, Bearer | Required | `@oal/gateway` authentication emulation |
| OAuth and OIDC | Shape only | Dummy bearer without discovery |
| mTLS | Unsupported | Capability diagnostic |
| Examples, defaults, const, enum generation | Required | `@oal/gateway` deterministic generator |
| JSON Schema generation | Required subset | `@oal/core` validator plus approximation report |
| Callbacks and webhooks | Preserved, not invoked | ContractIR metadata only |
| Links | Described only | Never auto-invoked |

## Behavior and evidence

| Capability | MVP status | Implementation |
| --- | --- | --- |
| Contract mode | Required | `@oal/gateway` without pack code |
| Scenario module | Required for approved packs | `@oal/behavior-runtime` child process; component tested, not wired to `oal serve` or `oal run` (plan F5) |
| Raw HTTP exposure | Required MVP | `@oal/gateway` server |
| Documentation facade | Phase 6 | `@oal/documentation-facade` |
| No-complete-contract treatment | Phase 6 | Planned in runner |
| ParticipantSurfaceManifest | Required MVP | Runner preflight and verification |
| Semantic event stream | Required for stateful packs | `@oal/evidence` semantic stream |
| Deterministic rubric | Required MVP | `@oal/evaluator` |
| Model judge | Optional later | Not implemented |
| Trusted custom evaluator | Optional later | Disabled in safe mode |
| Direct tools | Post-MVP reserved | `@oal/tools` naming and envelope; `oal run --exposure direct-tools` refuses (plan F6) |
| Catalog tools | Post-MVP reserved | `@oal/tools` search, describe, invoke; `oal run --exposure catalog-tools` refuses (plan F6) |
| Arazzo hidden grading | Post-MVP reserved | Planned compiler subset |

## Studies and adapters

| Capability | MVP status | Implementation |
| --- | --- | --- |
| StudyProtocol and PhasePlan | Phase 6 | `@oal/study-ir`, `@oal/study` |
| Study scheduling | Phase 6 | `@oal/scheduler` produces schedules, seeds, and ledgers; `oal study schedule` works, `oal study run` refuses to launch (plan F7) |
| Inferential study analysis | Phase 6 | `@oal/statistics` estimators; `oal study analyze` runs on an assembled study-run directory |
| Counterfactual ContractVariant | Phase 6 | `@oal/contract-variant` |
| Codex CLI adapter | Required MVP | `@oal/agent-codex` |
| Generic command adapter | Required MVP | `@oal/agent-generic` |
| Local hard sandbox | Platform dependent | Adapter capability declaration |
| Hosted service | Out of scope for MVP | Not implemented |
