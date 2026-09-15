# Pack webclip

A greenfield pack that demonstrates the friction-measurement loop on a
new API. webclip is a product API with no service behind it: it clips a
web page, renders it, extracts its text, and exports the capture. The
pack ships one naturalistic eval, `site-errand`, in which a participant
works through two clips and then describes the API from what it saw.

## Operations

| Operation                           | What it does                                       |
| ----------------------------------- | -------------------------------------------------- |
| `POST /v1/clips`                    | Creates one clip in the pending status             |
| `GET /v1/clips`                     | Returns one page of clips                          |
| `GET /v1/clips/{clipId}`            | Reads one clip                                     |
| `POST /v1/clips/{clipId}/render`    | Renders the clipped page                           |
| `GET /v1/clips/{clipId}/content`    | Serves the captured representation                 |
| `POST /v1/clips/{clipId}/extract`   | Extracts the text of a rendered clip               |
| `DELETE /v1/clips/{clipId}`         | Deletes one clip                                   |
| `GET /v1/account`                   | Reads the account quota                            |

The content endpoint declares two representations: `image/svg+xml`
with no schema and `text/markdown` with a string schema. The served
representation follows the clip's format and the `Accept` header.

## The loop this pack exists for

1. Run the eval and measure the friction with `oal friction` on the
   recorded batch.
2. Read the worklist. Each item names one incident a participant hit.
3. Author one response fixture per incident under `fixtures/` and wire
   it into `contract.response_fixtures` in `pack.yaml`.
4. Re-measure. The worklist should shrink.

## Recorded loop: webclip-before and webclip-after

Two paid 3-trial batches ran on 2026-08-30 and 2026-08-31
(`--eval site-errand --agent codex-cli --exposure raw-http`). The
contract file stayed in the workspace, so every participant read the
specification first.

| Measure                          | before | after |
| -------------------------------- | -----: | ----: |
| trials passed at score 1.0       | 1 of 3 | 3 of 3 |
| `two_clips_created`              |   1/3  |  3/3  |
| `errand_flow`                    |   3/3  |  3/3  |
| `comprehension_probe`            |   3/3  |  3/3  |
| HTTP exchanges                   |    38  |   47  |
| exchanges outside 2xx            |     0  |    0  |
| friction incidents               |     0  |    0  |
| operations served by a fixture   |     0  |    6  |

### Before: the mock misled, not the spec

No participant hit one 4xx or 5xx. Every participant read
`openapi.json`, then used the eight operations without one protocol
error. The failure sat elsewhere. Contract mode keeps no state, so
every `create_clip` answered with the same generated markdown clip,
and `list_clips` served the declared one-page example: one markdown
clip. Two of three participants concluded their image clip was lost,
created a third clip, and failed the exactly-two-clips check. One
session log says it plainly: "The retry had the same misleading
result."

### The fixture change

Six fixtures now cover the operations the errand touches. The list
page shows both clips. The account read reports one clip in use, which
matches the errand end state. The content endpoint keeps no fixture: a
fixture overrides Accept negotiation in the gateway, so wiring
`image/svg+xml` would serve the picture to a `text/markdown` request.
The delete keeps its generated empty 204.

### What the re-measure observed, and what it did not establish

The recorded re-measure observed three of three trials passing the
rubric as authored, each with exactly two create calls, with the
provenance mix moved from `fixture: 0` on every operation to six
fixture-served operations. The report quotes that mix per operation.

Those observations do not establish a general repair:

- Three trials with no control group show the pass rate moved together
  with the fixture change. They do not isolate the cause, and they do
  not bound the pass rate of a fourth trial.
- The mock remains stateless. Every `create_clip` serves the same
  fixture body, so an image create still returns the markdown clip
  body. The passing participants tolerated that mismatch; the errand
  does not verify it, and the full repair needs the behavior backend
  (plan F5 in `docs/review-fix-plan.md`).
- The rubric that produced score 1.0 checks the create-call count and
  the errand shape, not the served representations. The corrected
  grading rules (plan F4) demand more than the static fixtures can
  serve, so the recorded pass rate does not transfer to the corrected
  errand.

The friction report itself recorded zero incidents in both batches.
Its detectors are error-shaped: route misses, schema rejections,
framework errors, retries. This failure was 2xx-shaped. The responses
were all success codes that contradicted the requests. That is a
detector gap, not a clean bill of health, and it is the next analyzer
work item: a detector for response bodies that contradict the request
they answer.

One more limit is on purpose: the seeded error friction (enum guesses,
route misses) never fired, because the participants read the
specification before their first call.

## The corrected rubric (pack 0.2.0)

The rubric now grades the errand the task states. Two sequence
checks, one per clip, verify each lifecycle: create with the
requested URL and format, a render that reports `status: rendered`
in its body, content fetch through the requested `Accept` header
and the served `Content-Type` header, extraction and deletion
scoped to the markdown clip, and the quota read after the deletion.
The two chains may interleave. Header checks read the normalized
header view of the evaluator by name
(`event.request.header_values`), never a header array position.
Three further required checks keep the evidence honest: the two
create responses name two different identifiers, whichever clip is
created first; at least two creates succeed; and at most one
deletion succeeds. The report schema check stays, and all nine
claim fields must agree with the evidence through postconditions.

Seven required checks carry weight 1 each. A run fails when any
required check fails; one miss already drops the score to 6 of 7,
below the 0.9 threshold. Two recorded observations carry weight 0
and never fail the run: the comprehension probe (whether the
`api_model` answer names the clip resource) and the extra-create
count. The task states no exactly-two-creates constraint, so a third
create call is a diagnostic, not a failure. The result schema also
accepts an empty `uncertainties` list, so nobody must invent one.

## The behavior backend

Work item F5 landed the stateful backend this section used to await.
The pack ships a behavior module (`behavior/index.ts`) that implements
all eight operations against request-dependent synthetic state:

- Each create mints a distinct clip identifier and echoes its request.
- Render moves a clip to `rendered`, extraction refuses an unrendered
  clip with 409, and a deleted clip answers 404 on every later read.
- The content endpoint negotiates through the declared `Accept`
  schemas, so markdown and image fetches return their own types.
- Every committed change records a validated semantic event, and the
  account read counts live clips.

A scripted participant (`evals/site-errand/mock-participant.json`)
completes the corrected errand through `oal run` with disposition
`completed` and score 1. The old fixture limits are gone: identifiers
differ, quota follows the live clips, and 409 is reachable.

The recorded 3 of 3 pass rate of the webclip-after batch belongs to
pack 0.1.0 and its rubric. Old evidence and scores stay under their
original version; any re-scoring under the corrected rubric runs
through `oal report --regrade` and is labeled derived. The rubric is
not relaxed to keep the old pass rate.

## Layout

| Directory   | Purpose                                     |
| ----------- | ------------------------------------------- |
| contract/   | The hand-written webclip OpenAPI document   |
| fixtures/   | The six authored response bodies            |
| behavior/   | The stateful scenario behavior module       |
| prompts/    | Naturalistic prompt set instructions        |
| tasks/      | The site-errand work request                |
| schemas/    | The result schema and comprehension probe   |
| evals/      | The site-errand rubric and mock participants |
| tests/      | Reserved for pack-local checks              |

Validate with `oal pack validate <this-directory>`.
