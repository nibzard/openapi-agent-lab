# Example OpenAPI documents

Example contracts for a quick start with the lab. Point `oal serve` at the two documents that compile, `quickstart.json` and `steel-v1.json`:

```sh
oal inspect examples/quickstart.json
oal serve examples/quickstart.json --port 4010 --run-seed 42
```

| File | API | OpenAPI | Paths / operations | What it shows |
| --- | --- | --- | --- | --- |
| `quickstart.json` | Notes API | 3.1.0 | 2 / 5 | The starter. One readable screen. Bearer auth, pagination, filtering, error contract, partial update. |
| `steel-v1.json` | Steel Browser API | 3.0.3 | 26 / 41 | A production browser API for AI agents. Sessions, scraping, screenshots, and events. |
| `e2b.yaml` | E2B API | 3.0.0 | 48 / 64 | A production sandbox API. API-key and bearer schemes, long resource names, real-world texture. |

## Why this repository ships example contracts

Each file was picked for a reason. Together the set covers format, size, OpenAPI version, and quality:

- **`quickstart.json`** is written for this repository. It is small and clean. A user can start the lab with it before writing any contract. It is also the easy-to-read input for compiler tests.
- **`steel-v1.json`** is a production contract of moderate size. It supplies real operation names, real error shapes, and the OpenAPI 3.0.x format in JSON.
- **`e2b.yaml`** is a second production contract, in YAML. It supplies API-key and bearer schemes, more operations, and known defects. Two of its templated routes can match the same request path, so it does not compile: `oal inspect` reports `OAL-OAS-ROUTE-AMBIGUOUS` and serving is unavailable.

Selection rules for any file added to this directory:

1. The repository may distribute the file: written here, owned by Steel, or published under Apache-2.0.
2. The set must cover both JSON and YAML, and more than one OpenAPI minor version.
3. The set must contain at least one imperfect document. `oal inspect` must diagnose defects with stable reasons, so it needs defective inputs.

## Evaluated and not shipped

More vendor contracts were evaluated before this directory was fixed. They are not shipped, for these reasons:

| Reason | Cases |
| --- | --- |
| No stated license | Eleven production contracts published only as documentation endpoints. Redistribution rights are not granted, so they do not enter this repository. |
| Not an OpenAPI document | The AWS Bedrock AgentCore models are Smithy-derived Botocore service files, not OpenAPI. The compiler accepts OpenAPI 3.0.x and 3.1.x only. |
| Wrong version | One Swagger 2.0 contract. The compiler accepts OpenAPI 3.0.x and 3.1.x only. |
| Licensed but too large | The Cloudflare monolith is published under BSD-3-Clause, but it is a 24 MB document with more than 3,000 operations. It is not a starter example. Fetch it at test time when large-contract coverage is needed. |

An unlicensed contract can still be useful as a local test input. The rule is: fetch it at test time into an ignored directory, or point the lab at a local path outside this repository. Never commit it.

## Provenance and licenses

- **`quickstart.json`** was written for this repository. It is licensed under the [Apache License 2.0](../LICENSE), the same as the rest of this repository.
- **`steel-v1.json`** is the published contract of the Steel Browser API (`https://api.steel.dev`), retrieved on 2026-08-27. Copyright Steel. Included with permission. Steel is open source: https://github.com/steel-dev/steel-browser
- **`e2b.yaml`** is the published contract of the E2B API, retrieved on 2026-08-27 from https://github.com/e2b-dev/E2B/blob/main/spec/openapi.yml. That repository is licensed under the Apache License 2.0: https://github.com/e2b-dev/E2B/blob/main/LICENSE
- **`packs/slack/contract/openapi.json`** is the apis.guru snapshot of the Slack Web API, version 1.7.0, retrieved on 2026-08-30. It derives from Slack's published specs, maintained at https://github.com/slackapi/slack-api-specs under the MIT license. Every `xox*`-shaped example token was replaced by a short placeholder before the copy was committed.

Vendor contracts are kept in the format published by the vendor. They are snapshots, not mirrors. Fetch a fresh copy from the source when you need the current contract. Common linters report defects in them, such as dangling security requirements in `e2b.yaml`.
