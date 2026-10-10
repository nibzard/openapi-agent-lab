# Tutorial: author a stateful pack outside the workspace

This tutorial walks one full loop: install the tool, copy the
template, validate it, drive its one transition through the corpus,
checkpoint and fork the world, and run a scripted participant. Every
command below runs through the installed executable, and every
command is covered by an automated check.

## What you build

The template pack `external-demo` models a counter API with one
transition:

- `POST /counters` creates a counter at zero and emits the
  `counter.created` event.
- `GET /counters/{name}` reads one counter.
- `POST /counters/{name}/increment` moves the value by one and emits
  the `counter.incremented` event.

The pack carries a corpus of four cases, a reset case, an eval with
a rubric, and a fidelity declaration. It is the smallest complete
stateful pack.

## Prerequisites

- Node.js 24 or later.
- The archive tarballs, built inside the repository with
  `pnpm run archives`. The tarballs land in `dist/archives/`.

## Steps

1. Create a working directory outside the repository and install the
   archives offline:

   ```text
   mkdir external-pack && cd external-pack
   echo '{"name":"external-pack","private":true,"type":"module"}' > package.json
   npm install --offline --no-audit --no-fund <repo>/dist/archives/*.tgz
   ```

   The install needs no registry: the archive set is complete.

2. Copy the template beside your install:

   ```text
   cp -r <repo>/tests/fixtures/external-demo ./external-demo
   ./node_modules/.bin/oal pack validate ./external-demo
   ```

   The command prints the pack id, the manifest digest, and the
   operation count.

3. Run the corpus. Each case gets a fresh world; the reset case uses
   the world control to clear state:

   ```text
   ./node_modules/.bin/oal corpus run ./external-demo \
     --corpus demo-core --out corpus-report.json
   ```

   All four cases must pass. The report names every step, every
   assertion, and the run digest.

4. Serve the world, then fork it:

   ```text
   ./node_modules/.bin/oal serve ./external-demo --mode scenario \
     --port 0 --run-id demo --run-seed <64 hex chars>
   ```

   The serve prints a readiness record with the base URL and writes
   the world under `.oal/control/serve/demo`. Send requests with the
   bearer credential from that world's `credentials.json`. Take a
   checkpoint, stop the serve, and restore it:

   ```text
   ./node_modules/.bin/oal world checkpoint --world .oal/control/serve/demo --out checkpoint
   ./node_modules/.bin/oal world fork ./checkpoint --out fork --port 0
   ```

   The fork continues the counters, the identifiers, and the clock
   from the checkpoint.

5. Run the scripted participant through the eval:

   ```text
   ./node_modules/.bin/oal run ./external-demo --eval smoke \
     --agent mock-agent \
     --agent-script ./external-demo/evals/smoke/mock-participant.json \
     --batch smoke --format json
   ```

   The rubric checks the final report against the pack result schema
   and counts the transition requests in the trace.

6. Break the transition on purpose and watch the corpus fail:

   Edit `behavior/index.ts` and change
   `const next = counter.value + 1;` to
   `const next = counter.value;`. Run step 3 again. The
   `increment-transition` case fails with an assertion failure, and
   the command exits with code `2`.

## Where to go next

- Read `packs/webclip` for a larger scenario pack with faults and
  seeded state.
- Read `packs/github-issue-triage` for corpus-driven fidelity claims
  against a real service contract.
- Read `docs/authoring-packs.md` for the manifest fields.
