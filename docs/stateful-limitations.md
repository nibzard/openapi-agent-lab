# Stateful environments: unresolved limitations

This document records the limitations of the stateful milestone as
built. It ships with the release candidate so a reviewer reads the
boundaries before the evidence.

## External dependencies that block completion

- **Provider verification (SE-P5-03) has not run.** The environment
  holds no `GITHUB_TOKEN` and no dedicated disposable repository.
  `oal corpus verify` records the skip (exit code 4) and never turns
  it into a pass. The recorded skip is committed under
  `docs/evidence/github-verify-skip-2026-10-10/`. The local half of
  the job passes all eight cases; the provider half needs one run
  with a token restricted to a disposable repository.
- **No practitioner trial is recorded.** The plan asks for one agent
  developer and one service maintainer to try the external flow and
  report setup effort, a reproduced defect, fork replay, and corpus
  results. No human has run the trial yet; this release candidate
  invents no trial evidence.

## Engineering limitations

- **Behavior isolation is advisory.** Scenario behavior runs in a
  trusted-local child process. The schema worker boundary is
  enforced; the behavior child is not sandboxed.
- **Regular expressions evaluate synchronously.** Contract- and
  pack-supplied patterns run without a deadline inside the worker;
  a pathological pattern can consume the worker until its job
  deadline terminates it.
- **Study execution is partial.** `oal study schedule` works;
  `oal study run` refuses to launch participants (plan F7).
- **Corpus provider targets answer wall-clock waits.** The GitHub
  target waits by the real clock; only the local target owns
  virtual time.
- **The fidelity upgrade is manual by design.** `oal corpus verify`
  stamps observed claims into a review artifact; a human review
  promotes them into the pack.

Checkpoint directory version 2 verifies every file in the frozen behavior tree.
It rejects changed, missing, or added files and symbolic links before restore.
Version 1 directories lack this digest and are incompatible with this runtime.
Create a new checkpoint from the source world. The encrypted checkpoint document
remains at version 1.
