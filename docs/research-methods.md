# Research methods

This document explains how to run a preregistered study with the local
product. It covers the study layers, the lifecycle from protocol to analysis,
and the rules that keep results honest. See
[authoring studies](authoring-studies.md) for protocol authoring.

## Studies and batches

You do not need a study for most work. A single trial or a homogeneous cohort
needs only a pack, an eval, and `oal run`. See [usage](usage.md).

A study exists to compare cells under a registered design. A **cell** is one
resolved combination of factor levels. Any command that reports a treatment
effect, a p-value, or a winner requires a locked study first.

`oal compare` stays descriptive at all times. It renders two batches side by
side without pooling or significance claims.

## The research layers

Six layers each own one question:

| Layer         | Owns                                              |
| ------------- | ------------------------------------------------- |
| Pack          | The executable API world                          |
| Eval          | One task, its result contract, its scoring        |
| Run profile   | One homogeneous execution cell                    |
| StudyProtocol | Why and how cells may be compared                 |
| PhasePlan     | One frozen phase of the study                     |
| StudyRun      | The executed schedule and analysis lineage        |

A StudyProtocol declares factors, metrics, phases, eligibility, replacement
rules, and interpretation limits. A PhasePlan freezes one phase, including
assignments and the paid-call ceiling. A StudyRun executes the frozen
schedule across cell batches.

## Study lifecycle

### 1. Author the protocol

Scaffold a study directory from a local pack and eval:

```sh
oal study init ./studies/my-study-v1 \
  --pack ./packs/steel-computer \
  --eval basic-lifecycle \
  --id my-study-v1
```

Init refuses a non-empty target. It records only the pack ID, version, and
digest as a reference. It never records the host path. Edit the generated
protocol to declare factors, metrics, phases, and analysis limits. Read
[authoring studies](authoring-studies.md) for the document format.

### 2. Validate and lock

Validate the protocol against the local pack:

```sh
oal study validate ./studies/my-study-v1 \
  --pack ./packs/steel-computer \
  --phase pilot \
  --check-lock
```

Validation compiles the protocol, the factors, the phase plans, and the
analysis methods. It starts no agent. It fails when the pack reference does
not match the local pack by ID, version, and digest.

The lock is the frozen set of digests for every study member file:

- A missing lock fails `--check-lock`. This is the normal analytical path.
- `--write-lock` records the lock. It is an explicit maintainer action. It
  refuses a protocol version that already has paid analytical evidence.
- Any drift after the first paid analytical assignment requires a new
  protocol version and a new lock. Reanalysis of unchanged evidence creates
  a derived analysis, never an edited protocol.

Use `--materialize-contracts <dir>` to write contract variants into a new
directory for review.

### 3. Schedule the phase

Emit the deterministic assignment schedule:

```sh
oal study schedule ./studies/my-study-v1 \
  --phase pilot \
  --seed pilot-fixed-seed \
  --study-run my-study-pilot-01 \
  --out ./assignments.json
```

Without `--out`, the command previews. With `--out`, the target must not
exist. The file stays a candidate until `study run` binds its digest into
the phase lock. Scheduling starts no server, adapter, or provider call.

The schedule lists primary assignments and held replacements. Assignment
order derives from a canonical keyed hash. It never depends on completion
order, failure, or parallelism. The command reports cell counts, blocks, and
the maximum paid launches.

### 4. Run the phase

This build stops before participant launch. `oal study run` validates the
candidate schedule against the locked protocol, expands the cells, derives
the run bindings, prints the exact paid-call maximum, and probes the
adapter. It then refuses to launch with exit code `4`: the batch runner
allocates trial run IDs and cohort seeds itself and writes its own
assignment ledger, so scheduler bindings cannot be imposed from the CLI
yet. Connecting the two is work package F7 of the
[review fix plan](review-fix-plan.md).

```sh
oal study run ./studies/my-study-v1 \
  --phase pilot \
  --pack ./packs/steel-computer \
  --schedule ./assignments.json \
  --study-run my-study-pilot-01 \
  --model MODEL_ID \
  --effort high \
  --dry-run
```

The command refuses CLI values that disagree with the PhasePlan or the
candidate schedule. Use `--dry-run` to complete every check, print the
launch plan, and persist nothing. `--yes` and the interactive confirmation
apply to the launch path that F7 connects.

When the connection lands, evidence will land under
`.oal/studies/<study-run-id>/`, one ordinary child batch per cell under
`batches/`. An analytical phase refuses dirty provenance and an existing
study-run ID. There is no force flag.

### 5. Analyze the study run

Run the frozen analysis on an assembled study-run directory:

```sh
oal study analyze .oal/studies/my-study-pilot-01
```

Analysis verifies the protocol, phase, schedule, compatibility, and evidence
hashes first. It then executes exactly the frozen plan. A changed plan, a
changed rubric, or a different weighting creates a derived analysis with a
new lineage. It never overwrites the preregistered result.

Because no command launches a study yet, the study-run directory must be
assembled from engine outputs: the frozen inputs, the locks, the schedule,
the assignment ledger, and the cell batches that the scheduler and runner
produce. The command-line test suite assembles one this way. A study
launched end to end through the public commands is the F7 acceptance
control.

To aggregate compatible runs, name each input explicitly:

```sh
oal study analyze .oal/studies/my-study-pilot-01 \
  --include-study-run .oal/studies/my-study-pilot-02
```

## Replacement and denominators

Failures are classified before any replacement happens:

- Agent failure, timeout, budget exhaustion, and malformed reports count as
  real outcomes. They stay in the denominator as failures. Replacement is
  forbidden.
- Pre-control infrastructure or provider failure may activate a frozen
  held replacement from the same cell, when the PhasePlan declares one.
- Censored outcomes, such as corrupt evidence after participant control,
  enter the worst-case sensitivity as failures.

Every primary assignment defines exactly one analysis slot. A replacement
substitutes for that slot. It never adds a second observation.

Reports carry the full count ladder: primary assignments, activated
replacements, launched trials, control-started trials, evaluated trials, and
valid evaluations. Usage statistics count only observed values. Missing token
or cost data is unknown, never zero.

## Statistics the analyzer runs

The PhasePlan freezes every statistical choice before analytical data
exists. Built-in deterministic methods include:

- Raw rates with a Wilson interval.
- Risk difference with a Newcombe interval.
- Two-sided Fisher exact test.
- Holm step-down adjustment over a declared family.
- Median, quartiles, and range for durations and token counts.
- Paired differences only for preregistered, complete pairs.

Small pilots are labeled directional. Unplanned contrasts stay descriptive.
The analyzer refuses pooled estimates across different compatibility keys.

The methods above are the implemented ones. Requesting an unimplemented
option, such as a Wald interval, currently records a warning and reports the
implemented method instead. Rejecting unsupported options before analytical
execution is work package F3 of the
[review fix plan](review-fix-plan.md).

## Study artifacts

No command produces a complete StudyRun in this build; the layout below is
the target shape that the scheduler and analysis engines already write
piecewise. Sections marked with F7 in the [review fix plan](review-fix-plan.md)
land with durable trial execution. Each StudyRun directory follows this
shape:

```text
.oal/studies/<study-run-id>/
  study-run.json                  Execution header
  assignment-events.jsonl         Sole assignment ledger
  inputs/                         Frozen protocol, plans, locks, schedule
    study-protocol.frozen.yaml
    phase-plan.frozen.yaml
    protocol.lock.json
    phase.lock.json
    assignments.json
    analysis-plan.frozen.json
    variants/                     Materialized contract variants
    participant-surfaces/         Per-cell surface templates
    reviews/                      Equivalence and blinding reviews
  batches/<batch-id>/             One ordinary batch per cell
  analyses/
    preregistered/                The frozen analysis result
    derived/<analysis-id>/        Reanalysis lineages
  operational-diagnostics.json
  study.completed.json
```

Every write-once rule that protects batches also protects study inputs. See
[the quickstart](quickstart.md) for the batch layout inside each cell.
