#!/usr/bin/env node
/**
 * Fake Codex CLI for tests. Supports every flag the adapter can probe.
 */

import { FULL_FLAGS, runFakeCodex } from "./fake-codex-core.mjs";

const argv = process.argv.slice(2);
const code = await runFakeCodex(argv, FULL_FLAGS);
process.exit(code);
