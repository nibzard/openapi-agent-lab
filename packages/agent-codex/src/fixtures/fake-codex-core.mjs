/**
 * Shared logic for the fake Codex CLI fixtures.
 *
 * The fake mimics the three commands the adapter uses: `--version`,
 * `exec --help`, and `codex exec --json ... -`. It writes the same shapes the
 * real CLI writes, calls no model, and never touches the network.
 */

/** Flags the current fake reports in its help text. */
export const FULL_FLAGS = [
  "--json",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--output-schema",
  "--output-last-message",
  "--sandbox",
  "--skip-git-repo-check",
  "--model",
  "-c",
  "-C"
];

/** Flags an older CLI omits. */
export const LEGACY_FLAGS = FULL_FLAGS.filter(
  (flag) => flag !== "--output-last-message" && flag !== "--ephemeral"
);

export const FAKE_VERSION = "codex-cli 0.44.0 (fake, no model calls)";

/**
 * Run the fake CLI. Returns the process exit code and never throws.
 *
 * Behavior switches come from the environment so tests drive them through
 * the tool environment the adapter applies.
 */
export async function runFakeCodex(argv, supportedFlags) {
  const env = process.env;
  if (argv[0] === "--version") {
    process.stdout.write(`${FAKE_VERSION}\n`);
    return 0;
  }
  if (argv[0] === "exec" && argv[1] === "--help") {
    process.stdout.write(helpText(supportedFlags));
    return 0;
  }
  if (argv[0] !== "exec") {
    process.stderr.write(`unknown command: ${String(argv[0])}\n`);
    return 2;
  }
  return await runExec(argv.slice(1), env);
}

function helpText(flags) {
  const lines = [
    "Executes a coding task non-interactively",
    "",
    "Usage: codex exec [OPTIONS] [PROMPT]",
    "",
    "Options:",
    "  -                    Read the prompt from stdin when the prompt argument is -",
    ...flags.map((flag) => `  ${flag.padEnd(24)} supported by this build`)
  ];
  return `${lines.join("\n")}\n`;
}

async function runExec(args, env) {
  const exitCode = Number.parseInt(env.FAKE_CODEX_EXIT_CODE ?? "0", 10);
  const stderrNote = env.FAKE_CODEX_STDERR ?? "";
  const hangMs = Number.parseInt(env.FAKE_CODEX_HANG_MS ?? "0", 10);
  let outputLastMessage = null;
  let readsStdin = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output-last-message") {
      outputLastMessage = args[index + 1] ?? null;
      index += 1;
    } else if (arg === "-") {
      readsStdin = true;
    }
  }
  const prompt = readsStdin ? await readStdin() : "(no prompt)";
  if (hangMs > 0) {
    await delay(hangMs);
  }
  if (stderrNote !== "") {
    process.stderr.write(`${stderrNote}\n`);
  }
  if (exitCode !== 0 && env.FAKE_CODEX_EXIT_AFTER_EVENTS !== "1") {
    return Number.isInteger(exitCode) ? exitCode : 0;
  }
  const lines = [
    { type: "thread.started", thread_id: "th_fake0001" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: `fake agent processed ${prompt.length} prompt characters`
      }
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 120,
        cached_input_tokens: 64,
        output_tokens: 35,
        total_tokens: 155
      }
    }
  ];
  if (env.FAKE_CODEX_REPORT_ENV === "1") {
    lines.splice(2, 0, {
      type: "item.completed",
      item: {
        type: "agent_message",
        text: `env names: ${Object.keys(env).sort().join(",")}`
      }
    });
  }
  process.stdout.write(
    lines.map((line) => `${JSON.stringify(line)}\n`).join("")
  );
  if (exitCode !== 0) {
    return exitCode;
  }
  if (outputLastMessage !== null) {
    const final = env.FAKE_CODEX_FINAL_TEXT ?? prompt.trim();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outputLastMessage, `${final}\n`);
  }
  return 0;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => {
      resolve(text);
    });
    process.stdin.on("error", () => {
      resolve("");
    });
  });
}
