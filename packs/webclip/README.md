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

Fixture status: none yet — the bare contract is the before state.

## Layout

| Directory   | Purpose                                     |
| ----------- | ------------------------------------------- |
| contract/   | The hand-written webclip OpenAPI document   |
| prompts/    | Naturalistic prompt set instructions        |
| tasks/      | The site-errand work request                |
| schemas/    | The result schema and comprehension probe   |
| evals/      | The site-errand rubric                      |
| tests/      | Reserved for pack-local checks              |

Validate with `oal pack validate <this-directory>`.
