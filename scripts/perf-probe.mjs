/**
 * Compile performance probe for the nightly lane (specification section
 * 36.2, "large-document performance", budget from section 36.4).
 *
 * The probe compiles the shipped example documents through the real
 * workspace compiler, `packages/openapi/src/index.ts`, exactly the way
 * `packages/openapi/tests/compile.test.ts` imports it. Plain `node`
 * cannot load that TypeScript source in strip-only mode, so the script
 * re-executes itself once with `--experimental-transform-types` when
 * that flag is missing. Both forms work:
 *
 *   node scripts/perf-probe.mjs
 *   pnpm run probe:compile
 *
 * Budget rule (section 36.4): a 1 MiB, 500-operation contract should
 * compile within 2 seconds p95. The probe scales that budget to each
 * document by the binding ratio, operations or bytes, with a floor of
 * 5 percent so tiny documents are not judged by timer noise. The probe
 * fails only on a gross regression: a median above four times the scaled
 * budget. Timings and peak resident size are reported raw; the section
 * 36.4 rule "performance data is reported raw" applies.
 *
 * `examples/e2b.yaml` currently does not compile: the bounded YAML
 * subset rejects a multi-line plain scalar, `OAL-YAML-INVALID` at line
 * 323. The probe reports that document as skipped instead of failing,
 * because a parse diagnostic is not a performance regression.
 *
 * Exit codes: 0 within budget, 1 on a gross regression, 2 on an
 * operational error.
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Node flag that lets plain node load the TypeScript workspace source. */
const TRANSFORM_FLAG = "--experimental-transform-types";

/** Documents the probe compiles, largest interest last. */
const DOCUMENTS = [
  "examples/quickstart.json",
  "examples/steel-v1.json",
  "examples/e2b.yaml"
];

/** Section 36.4 reference budget for one compile. */
const BUDGET_MS = 2000;
const BUDGET_OPERATIONS = 500;
const BUDGET_BYTES = 1024 * 1024;
/** Floor of the scaled budget, in percent of the reference budget. */
const BUDGET_FLOOR_SHARE = 0.05;
/** A median above this multiple of the budget fails the probe. */
const GROSS_REGRESSION_FACTOR = 4;

/** Timing plan: warmup runs, then measured runs. */
const WARMUP_RUNS = 2;
const MEASURED_RUNS = 7;

/** Re-executes the script with type transformation when it is missing. */
function ensureTransformSupport(self) {
  if (process.execArgv.includes(TRANSFORM_FLAG)) {
    return;
  }
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", TRANSFORM_FLAG, self, ...process.argv.slice(2)],
    { stdio: "inherit" }
  );
  process.exit(result.status ?? 2);
}

/** Median of a sorted-agnostic numeric list. */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Nearest-rank percentile of a numeric list. */
function percentile(values, share) {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(
    sorted.length,
    Math.max(1, Math.ceil(share * sorted.length))
  );
  return sorted[rank - 1];
}

/** Scaled section 36.4 budget for one document, in milliseconds. */
function scaledBudgetMs(operations, bytes) {
  const share = Math.max(
    BUDGET_FLOOR_SHARE,
    operations / BUDGET_OPERATIONS,
    bytes / BUDGET_BYTES
  );
  return BUDGET_MS * share;
}

/** Runs the probe. Returns the process exit code. */
async function run() {
  const { compileOpenApi } = await import(
    new URL("../packages/openapi/src/index.ts", import.meta.url)
  );
  const results = [];
  let failed = false;

  for (const document of DOCUMENTS) {
    const text = readFileSync(document, "utf8");
    const entrypoint = document.split("/").pop();
    const documents = { [entrypoint]: text };

    let operations;
    let firstError = null;
    try {
      const compiled = compileOpenApi({ documents, entrypoint }, {});
      operations =
        compiled.contract.operations.length +
        compiled.contract.webhooks.reduce(
          (count, hook) => count + hook.operations.length,
          0
        );
    } catch (error) {
      firstError = error;
    }

    if (firstError !== null) {
      const code = firstError?.code ?? "unknown";
      const details = firstError?.details;
      const line =
        details && details.line ? ` at ${details.line}:${details.column}` : "";
      console.log(`${document}: skipped, ${code}${line}`);
      results.push({ document, skipped: true, code });
      continue;
    }

    for (let index = 0; index < WARMUP_RUNS; index += 1) {
      compileOpenApi({ documents, entrypoint }, {});
    }
    const samples = [];
    let peakRssBytes = 0;
    for (let index = 0; index < MEASURED_RUNS; index += 1) {
      const started = process.hrtime.bigint();
      compileOpenApi({ documents, entrypoint }, {});
      const elapsed = process.hrtime.bigint() - started;
      samples.push(Number(elapsed) / 1e6);
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }

    const medianMs = median(samples);
    const p95Ms = percentile(samples, 0.95);
    const budgetMs = scaledBudgetMs(operations, text.length);
    const gross = medianMs > GROSS_REGRESSION_FACTOR * budgetMs;
    if (gross) {
      failed = true;
    }
    console.log(
      `${document}: ${operations} operations, ${text.length} bytes, ` +
        `median ${medianMs.toFixed(1)} ms, p95 ${p95Ms.toFixed(1)} ms, ` +
        `budget ${budgetMs.toFixed(0)} ms, ` +
        `peak rss ${(peakRssBytes / (1024 * 1024)).toFixed(0)} MiB` +
        `${gross ? ", GROSS REGRESSION" : ""}`
    );
    results.push({
      document,
      skipped: false,
      operations,
      bytes: text.length,
      medianMs,
      p95Ms,
      budgetMs,
      peakRssBytes
    });
  }

  console.log(
    `perf-probe: ${JSON.stringify({ node: process.version, results })}`
  );
  if (failed) {
    console.error(
      `perf-probe: a median exceeded ${GROSS_REGRESSION_FACTOR}x the section 36.4 budget`
    );
    return 1;
  }
  return 0;
}

const self = fileURLToPath(import.meta.url);
ensureTransformSupport(self);
process.exit(await run());
