# Example OpenAPI documents

Example contracts for a quick start with the lab. Point `oal serve` at any file in this directory:

```sh
oal inspect examples/quickstart.json
oal serve examples/quickstart.json --port 4010 --run-seed 42
```

| File | API | OpenAPI | Paths / operations | What it shows |
| --- | --- | --- | --- | --- |
| `quickstart.json` | Notes API | 3.1.0 | 2 / 5 | The starter. One readable screen. Bearer auth, pagination, filtering, error contract, partial update. |
| `steel-v1.json` | Steel Browser API | 3.0.3 | 26 / 41 | A production browser API for AI agents. Sessions, scraping, screenshots, and events. |
| `e2b.yaml` | E2B API | 3.0.0 | 48 / 64 | A production sandbox API. API-key and bearer schemes, long resource names, real-world texture. |

## Provenance and licenses

- **`quickstart.json`** was written for this repository. It is licensed under the [Apache License 2.0](../LICENSE), the same as the rest of this repository.
- **`steel-v1.json`** is the published contract of the Steel Browser API (`https://api.steel.dev`), retrieved on 2026-08-27. Copyright Steel. Included with permission. Steel is open source: https://github.com/steel-dev/steel-browser
- **`e2b.yaml`** is the published contract of the E2B API, retrieved on 2026-08-27 from https://github.com/e2b-dev/E2B/blob/main/spec/openapi.yml. That repository is licensed under the Apache License 2.0: https://github.com/e2b-dev/E2B/blob/main/LICENSE

Vendor contracts are kept in the format published by the vendor. They are snapshots, not mirrors. Fetch a fresh copy from the source when you need the current contract.

The vendor snapshots are not perfect documents. Common linters report defects in them, such as dangling security requirements. This is intentional. `oal inspect` must report such defects with stable reasons, so these files also serve as imperfect inputs for testing.
