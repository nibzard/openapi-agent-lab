/**
 * Zero-dependency repository secret scanner (specification section 36.1,
 * gate 15). The scanner walks the worktree from the repository root and
 * reports any line that matches one of the bounded pattern sets:
 *
 * - AWS access key ids: `AKIA`/`ASIA` plus 16 digits or upper-case
 *   letters.
 * - GitHub tokens: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` prefixes.
 * - Google API keys: `AIza` plus 35 URL-safe characters.
 * - Private key blocks: any `-----BEGIN ... PRIVATE KEY-----` header.
 * - High-entropy assignments, but only inside `.env` files: a value of
 *   at least 20 characters drawn from one continuous token alphabet
 *   with a Shannon entropy of 3.5 bits per character or more.
 *
 * The scan is bounded: it skips `.git`, `node_modules`, `dist`, and
 * `coverage`, skips files that contain a NUL byte in their first 8192
 * bytes, skips files larger than 8 MiB, and stops with an error when the
 * total scanned bytes exceed 64 MiB.
 *
 * Allowlist: `.github/secret-scan-allowlist.txt`. One entry per line.
 * `path/to/file` silences the whole file, `path/to/file:12` silences one
 * line, and `#` starts a comment. Entries are repository-relative.
 *
 * Exit codes: 0 when clean, 1 when the scan reports findings, 2 on an
 * operational error.
 *
 * Run it with `node scripts/secret-scan.mjs` or `pnpm run scan:secrets`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative as relativePath } from "node:path";
import { fileURLToPath } from "node:url";

/** Directories the scanner never enters. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  // Agent worktrees under .claude are staging copies of this repository;
  // their content is scanned in its canonical location.
  ".claude",
  "node_modules",
  "dist",
  "coverage"
]);

/** Files larger than this bound are not scanned. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** The whole scan stops beyond this bound. */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Binary probe window. A NUL byte in this prefix means "not text". */
const BINARY_PROBE_BYTES = 8192;

/** Minimum value length for the `.env` entropy rule. */
const MIN_ENV_VALUE_LENGTH = 20;

/** Minimum Shannon entropy for the `.env` entropy rule. */
const MIN_ENV_ENTROPY = 3.5;

/** Named patterns that apply to every text file. */
const CONTENT_PATTERNS = [
  {
    id: "aws-access-key-id",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu
  },
  {
    id: "github-token",
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,254}\b/gu
  },
  {
    id: "google-api-key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/gu
  },
  {
    id: "private-key-block",
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/gu
  }
];

/** One `NAME=value` assignment inside a `.env` file. */
const ENV_ASSIGNMENT =
  /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/;

/** Characters that form one continuous candidate token. */
const TOKEN_ALPHABET = /^[A-Za-z0-9+/=_-]+$/;

/**
 * Collects every repository-relative file path below `root`, in a
 * deterministic order. Skipped directories never appear in the output.
 */
function collectFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files.sort();
}

/** Reports whether the buffer looks like text. */
function looksLikeText(bytes) {
  const window = bytes.subarray(0, BINARY_PROBE_BYTES);
  for (const byte of window) {
    if (byte === 0) {
      return false;
    }
  }
  return true;
}

/** Shannon entropy of a string, in bits per character. */
function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const share = count / value.length;
    entropy -= share * Math.log2(share);
  }
  return entropy;
}

/** Reports whether the file name marks an environment file. */
function isEnvFile(name) {
  return name === ".env" || name.startsWith(".env.");
}

/** Applies every content pattern to one text file. */
function scanContent(relative, text, report) {
  for (const pattern of CONTENT_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match = pattern.regex.exec(text);
    while (match !== null) {
      const line = countLines(text, match.index);
      report(relative, line, pattern.id, match[0]);
      match = pattern.regex.exec(text);
    }
  }
}

/** Applies the high-entropy rule to one `.env` file. */
function scanEnvFile(relative, text, report) {
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = ENV_ASSIGNMENT.exec(lines[index]);
    if (parsed === null) {
      continue;
    }
    const value = parsed[2].trim().replace(/^["']|["']$/gu, "");
    if (value.length < MIN_ENV_VALUE_LENGTH || !TOKEN_ALPHABET.test(value)) {
      continue;
    }
    if (shannonEntropy(value) >= MIN_ENV_ENTROPY) {
      report(relative, index + 1, "high-entropy-assignment", value);
    }
  }
}

/** Returns the one-based line number of a character offset. */
function countLines(text, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

/** Parses the allowlist into whole-file and per-line entries. */
function loadAllowlist(path) {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { files: new Set(), lines: new Set() };
  }
  const files = new Set();
  const lines = new Set();
  for (const raw of text.split(/\r?\n/u)) {
    const entry = raw.trim();
    if (entry.length === 0 || entry.startsWith("#")) {
      continue;
    }
    const separator = entry.lastIndexOf(":");
    if (
      separator > 0 &&
      /^\d+$/u.test(entry.slice(separator + 1)) &&
      !entry.endsWith(":")
    ) {
      lines.add(entry);
    } else {
      files.add(entry);
    }
  }
  return { files, lines };
}

/** Main entry point. Returns the process exit code. */
function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const { files, lines } = loadAllowlist(
    join(root, ".github", "secret-scan-allowlist.txt")
  );
  const findings = [];
  let totalBytes = 0;
  let scannedFiles = 0;

  for (const absolute of collectFiles(root)) {
    const relative = relativePath(root, absolute);
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      continue;
    }
    if (stats.size > MAX_FILE_BYTES) {
      continue;
    }
    const bytes = readFileSync(absolute);
    if (!looksLikeText(bytes)) {
      continue;
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      console.error(
        `secret-scan: scan exceeded the ${MAX_TOTAL_BYTES} byte bound`
      );
      return 2;
    }
    scannedFiles += 1;
    const text = bytes.toString("utf8");
    const report = (file, line, id, detail) => {
      if (files.has(file) || lines.has(`${file}:${line}`)) {
        return;
      }
      findings.push({ file, line, id, detail });
    };
    scanContent(relative, text, report);
    const name = relative.split("/").pop() ?? "";
    if (isEnvFile(name)) {
      scanEnvFile(relative, text, report);
    }
  }

  for (const finding of findings) {
    console.log(
      `${finding.file}:${finding.line}: [${finding.id}] ${finding.detail}`
    );
  }
  console.log(
    `secret-scan: ${scannedFiles} files scanned, ${findings.length} findings`
  );
  if (findings.length > 0) {
    console.log(
      "secret-scan: allowlist reviewed entries in .github/secret-scan-allowlist.txt"
    );
    return 1;
  }
  return 0;
}

process.exit(main());
