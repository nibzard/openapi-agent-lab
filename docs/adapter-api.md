# Adapter API

An adapter turns one normalized run context into one agent process. The
`@oal/agent-adapter` package defines the interface. This document describes
the credential contract of the adapters this build constructs.

## Selectors

This build constructs two adapters without a configuration file:

- `mock-agent`: an in-process scripted agent that serves as the pipeline
  check. It needs no credential.
- `codex-cli`: the Codex CLI adapter of `@oal/agent-codex` (specification
  section 21.4). It authenticates every non-interactive run.

A generic command adapter in `@oal/agent-generic` covers other local agent
commands.

## Launcher credentials

The runner copies only the launcher environment names an adapter declares
from the host environment. Their values reach the child process and are
never recorded. The participant tool environment never sees them.

The `codex-cli` adapter declares `CODEX_API_KEY` by default. Codex 0.154
authenticates non-interactive runs from `CODEX_API_KEY` or an `auth.json`
file under `CODEX_HOME`. `CODEX_HOME` defaults to `~/.codex`.
`OPENAI_API_KEY` does not authenticate codex 0.154 non-interactively. A run
with only that variable set fails with 401 after a paid probe.

### Overrides

`launcherEnvironmentNames` follows three rules:

1. An absent declaration resolves to `["CODEX_API_KEY"]`.
2. An explicit list replaces the default.
3. An explicit empty list also replaces the default, so the child process
   receives no launcher credential.

A declaration at probe time beats the constructor value:

```ts
const adapter = new CodexCliAdapter();
await adapter.probe({ launcherEnvironmentNames: ["OTHER_KEY"] });
```

The adapter probe itself carries no credentials. It runs `codex --version`
and `codex exec --help` with a bare environment.

## Doctor check

`oal doctor --agent codex-cli` adds one check with the stable id
`adapter.codex_credential` (specification section 23.13). The check reports
which credential the host provides:

- `CODEX_API_KEY` set: pass.
- An `auth.json` under `CODEX_HOME`: pass. The check reads `CODEX_HOME`
  first, then falls back to `~/.codex`.
- Only `OPENAI_API_KEY` set: warn. Codex 0.154 ignores it for
  non-interactive runs.
- No credential: fail.

The check prints names and presence only. It never prints a value, a file
content, or anything derived from a value. Runs with other adapters grow no
codex credential check.
