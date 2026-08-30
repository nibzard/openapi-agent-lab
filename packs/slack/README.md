# Pack slack

Contract-mode pack built from the Slack Web API snapshot. It ships one
diagnostic eval, `fix-mock`, in which an operator agent probes every
operation and authors response fixtures for the failures it finds.

## Contract fidelity

The mock answers only from the OpenAPI document: declared examples,
schemas, and response selectors. It claims no business semantics. The
`fix-mock` eval exists for the case where the document itself is not
enough: 34 operations ship vendor examples that violate the vendor's
own schemas.

## The fix-mock loop

The eval was rehearsed against a staged gateway with the SPEC 15.5
example-skip rule disabled, so the mock showed the raw contract defects.
One paid `codex-cli` trial then ran the loop:

1. The participant ran `node probe.mjs`. The probe found 34 failures,
   all `500 mock_response_invalid`.
2. The participant read `probe-report.json` and authored one fixture
   body per failure under `authored/`.
3. The trial answered a structured report: 3 probe runs, 34 failures,
   34 fixtures, 35 files. The rubric passed with score 1.
4. The operator wired the 34 bodies into `response_fixtures` and
   re-probed. Both trees then answered 174 operations, 174 times 200.

Step 4 was verified twice: on the repaired gateway with the skip rule
active, and on the staged gateway with the rule still disabled. The
fixtures alone repair the mock.

A fresh `fix-mock` run on the shipped tree finds no failures: the
skip rule already repairs all 34 operations before any fixture is
served. The eval records the operator workflow. To reproduce the
failure worklist, stage a gateway with the skip rule disabled, as the
paid demo did.

## Recorded tallies

| Tree                               | Tally               |
| ---------------------------------- | ------------------- |
| Staged gateway, no fixtures        | 140 x 200, 34 x 500 |
| Repaired gateway, no fixtures      | 174 x 200           |
| Either gateway, fixtures wired in  | 174 x 200           |

## Layout

| Directory     | Purpose                                     |
| ------------- | ------------------------------------------- |
| contract/     | The redacted Slack OpenAPI snapshot         |
| fixtures/     | Response bodies authored by the paid trial  |
| prompts/      | Diagnostic prompt set instructions          |
| tasks/        | The fix-mock task document                  |
| schemas/      | The structured report schema                |
| evals/        | The fix-mock rubric                         |
| participants/ | The probe used by agent and operator        |

Validate with `oal pack validate <this-directory>`.
