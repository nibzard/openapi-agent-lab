#!/usr/bin/env node
/**
 * Fake Codex CLI for tests of an older build. Its help text omits two
 * required flags, so the probe must refuse the driver.
 */

import { LEGACY_FLAGS, runFakeCodex } from "./fake-codex-core.mjs";

const argv = process.argv.slice(2);
const code = await runFakeCodex(argv, LEGACY_FLAGS);
process.exit(code);
