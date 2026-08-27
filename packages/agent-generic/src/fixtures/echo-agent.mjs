/**
 * Test fixture: a fake agent command driven by its environment.
 *
 * The generic adapter passes exactly the tool environment, so the fixture
 * reads every switch from `process.env`. It writes machine-readable session
 * events to stdout, an optional final message, and exits with the declared
 * code. No model is called.
 */

import { writeFileSync } from "node:fs";

const env = process.env;

function count(name) {
  const value = Number.parseInt(env[name] ?? "0", 10);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

const reportEnvironment = env.FIXTURE_REPORT_ENV === "1";
const jsonEvents = count("FIXTURE_JSON_EVENTS");
const textLines = count("FIXTURE_TEXT_LINES");
const finalText = env.FIXTURE_FINAL_TEXT ?? "";
const finalFile = env.FIXTURE_FINAL_FILE ?? "";
const exitCode = Number.parseInt(env.FIXTURE_EXIT_CODE ?? "0", 10);

const lines = [];
if (reportEnvironment) {
  lines.push(
    JSON.stringify({
      type: "environment",
      text: `names=${Object.keys(env).sort().join(",")}`,
      cwd: process.cwd()
    })
  );
}
for (let index = 0; index < jsonEvents; index += 1) {
  lines.push(
    JSON.stringify({
      type: "session_event",
      text: `event ${index + 1}`,
      item: index + 1
    })
  );
}
if (jsonEvents > 0) {
  lines.push(
    JSON.stringify({
      type: "turn.completed",
      text: "turn finished",
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 }
    })
  );
}
for (let index = 0; index < textLines; index += 1) {
  lines.push(`plain line ${index + 1}`);
}
if (env.FIXTURE_SECRET !== undefined) {
  lines.push(`secret seen: ${env.FIXTURE_SECRET}`);
}
if (env.FIXTURE_STDIN === "1") {
  let received = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    received += chunk;
  });
  process.stdin.on("end", () => {
    lines.push(`stdin=${received.trim()}`);
    finish();
  });
} else {
  finish();
}

function finish() {
  if (finalText !== "") {
    lines.push(finalText);
  }
  process.stdout.write(lines.map((line) => `${line}\n`).join(""));
  if (finalFile !== "") {
    writeFileSync(finalFile, `${finalText}\n`);
  }
  process.exit(Number.isInteger(exitCode) ? exitCode : 0);
}
