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

## Layout

| Directory   | Purpose                                     |
| ----------- | ------------------------------------------- |
| contract/   | The hand-written webclip OpenAPI document   |
| fixtures/   | The six authored response bodies            |
| prompts/    | Naturalistic prompt set instructions        |
| tasks/      | The site-errand work request                |
| schemas/    | The result schema and comprehension probe   |
| evals/      | The site-errand rubric                      |
| tests/      | Reserved for pack-local checks              |

Validate with `oal pack validate <this-directory>`.
