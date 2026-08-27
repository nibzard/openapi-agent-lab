# External component decisions

Status: accepted for version 0.1. Revisit each note before adding any runtime
dependency.

## Context

Section 37 of the specification names four external components: Stoplight
Prism, Microcks, Schemathesis, and Arazzo tooling. The repository also locks a
governance rule: the reference implementation is Node.js 24 LTS, strict
TypeScript, and no runtime npm dependencies. The state store, HTTP server, YAML
parser, JSON schema validator, and PRNG are all built in-house on `node:*`
modules.

## Decision notes

### Stoplight Prism

- **Decision: deferred. The built-in deterministic generator is the version
  0.1 contract-response adapter.**
- Reason: Prism cannot guarantee byte-identical output for a frozen operation,
  validated request, response-selection policy, and seed. The specification
  requires that invariant from every `MockAdapter`. The built-in generator in
  `@oal/gateway` provides it by construction.
- The `MockAdapter` interface stays the integration point. A Prism adapter may
  be added later behind that interface only. It must pass the double-invoke
  determinism check before any cohort uses it.
- When added, OAL keeps routing, authentication emulation, limits, event shape,
  redaction, and final response validation. Prism would receive one derived
  single-operation document per call, never route authority.

### Microcks

- **Decision: not used in version 0.1.**
- Reason: the stateful mock backend already exists in `@oal/state-store` and
  the behavior runtime. A Microcks backend would be a separate research
  treatment, not a replacement.
- Any future adapter must emit the normalized `api.exchange` trace and follow
  the artifact, security, and experiment-cell rules.

### Schemathesis

- **Decision: planned as a CI conformance lane, not an evaluator.**
- Reason: generated traffic is control traffic. It must never appear as
  participant behavior in a trial.
- The lane runs against the gateway black-box conformance suite. The in-repo
  suite in `packages/gateway` covers the same ground with deterministic seeds,
  so Schemathesis adds value only as an independent cross-check.

### Arazzo

- **Decision: implement a version 1.1.x compiler subset in-house.**
- Reason: the supported runtime-expression subset is small and must fail
  strict validation rather than degrade silently. An external engine would
  widen the trusted surface for no gain.
- The capability report states the supported version and subset explicitly.

## Dependency governance

The following rules are locked for the workspace:

- Zero runtime npm dependencies. Development dependencies only: TypeScript,
  ESLint, Prettier, Vitest, and their type packages.
- Every storage, network, and parsing primitive uses `node:*` built-ins.
- Package `exports` point at TypeScript source. Node 24 runs it directly.
- Upgrades go through `pnpm-lock.yaml` review. The lockfile pins exact
  resolved versions.
- No third-party diagnostic string becomes a stable API. Diagnostics carry
  OAL codes and bounded messages.

## Consequences

- The mock, validator, YAML parser, and statistics code need their own test
  suites. They exist inside the owning packages.
- Differential testing against Prism is a future task. It requires the golden
- response corpus from task T041 first.
- Adding any runtime dependency requires a new decision note and a
  specification change review.
