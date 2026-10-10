# github-issue-triage

A provider-fidelity pack for the GitHub Issues triage surface. The
provider API version is pinned to 2026-03-10 and was rechecked on
2026-10-10 against the issue and label endpoint documentation.

The modeled surface is five operations under
`/repos/{owner}/{repo}`: create, read, list with explicit state and
bounded pagination, add the pre-existing label `oal-triage`, and
close with `state: closed`.

Outside the surface: label administration, comments, search,
webhooks, pull-request behavior, and broad permission emulation.
Unsupported input combinations answer 422 with a problem body.

The corpus declares the eight fixed core cases of SPEC section 48.7.
Fidelity claims live in `fidelity/claims.json` with their evidence
class and sources; documentation review is not live behavioral
verification, so every provider claim is `documented` or
`unsupported` until a live run records otherwise.
