# Recorded provider verification skip (SE-P5-03)

This directory records the honest state of the provider verification
job on 2026-10-10. The environment held no `GITHUB_TOKEN` and no
dedicated disposable repository, so the provider half of
`oal corpus verify` could not run. Per the plan, missing credentials
stay a recorded skip that blocks completion; they never become a
pass.

## How this was produced

One run of:

```text
oal corpus verify packs/github-issue-triage \
  --corpus issue-triage-core \
  --input owner=example --input repository=triage \
  --repository example/triage --allow-live-writes \
  --out docs/evidence/github-verify-skip-2026-10-10
```

with `GITHUB_TOKEN` unset. The command exited with code 4
(unsupported) and printed: `Provider verification skipped:
GITHUB_TOKEN is not set. This blocks fidelity completion; it is not
a pass.`

## Files

- `corpus-local.json`: the local target report. All eight core
  cases passed against the pack's emulator. This is the gating half
  of the job; the provider half never started.
- `skip.json`: the recorded skip (kind `VerificationSkip`, reason
  `GITHUB_TOKEN is not set`).

The automated end-to-end coverage for the full job — including a
provider double over real HTTP and the stamped observed claims —
lives in `apps/cli/src/corpus-verify.test.ts`. Continuous
integration runs it without a token and without network access.

## What completion still needs

1. A token restricted to one disposable repository, exported as
   `GITHUB_TOKEN`.
2. The same command against that repository. It must report eight
   passing cases on both targets, close every created issue, and
   write `corpus-github.json` plus `fidelity-observed.json`.
3. A reviewed commit that updates the pack's fidelity claims from
   `documented` to `observed`; the command never edits the pack in
   place.
