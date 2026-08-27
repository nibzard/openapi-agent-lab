import type { ExitCode } from "@oal/core";

import type { FlagView, OptionSpec } from "./argv.ts";
import type { RunContext } from "./context.ts";
import { inspectCommand } from "./handlers/inspect.ts";
import { helpCommand, versionCommand } from "./handlers/misc.ts";
import { stubCommand } from "./handlers/stub.ts";
import type { Io } from "./io.ts";

/** Everything a command handler receives. */
export interface CommandArgs {
  readonly command: CommandSpec;
  readonly registry: CommandRegistry;
  readonly positionals: readonly string[];
  readonly flags: FlagView;
  readonly context: RunContext;
}

/** Handler contract: async, returns the process exit code. */
export type CommandHandler = (args: CommandArgs, io: Io) => Promise<ExitCode>;

export interface CommandArgument {
  /** Positional name without angle brackets. */
  readonly name: string;
  readonly description: string;
}

export interface CommandSpec {
  /** Full name including the subcommand, for example "pack init". */
  readonly name: string;
  readonly summary: string;
  readonly arguments: readonly CommandArgument[];
  readonly options: readonly OptionSpec[];
  readonly handler: CommandHandler;
}

export interface CommandRegistry {
  /** Registered commands in help order. */
  readonly commands: readonly CommandSpec[];
  /** First words of multi-word command names. */
  readonly namespaces: readonly string[];
  resolve(name: string): CommandSpec | null;
  subcommandsOf(namespace: string): readonly CommandSpec[];
}

export function createCommandRegistry(
  commands: readonly CommandSpec[]
): CommandRegistry {
  const byName = new Map<string, CommandSpec>();
  for (const command of commands) {
    if (byName.has(command.name)) {
      throw new Error(`Duplicate command name "${command.name}".`);
    }
    byName.set(command.name, command);
  }
  const namespaces = [
    ...new Set(
      commands
        .filter((command) => command.name.includes(" "))
        .map((command) => command.name.split(" ")[0] ?? "")
    )
  ];
  return {
    commands,
    namespaces,
    resolve: (name: string): CommandSpec | null => byName.get(name) ?? null,
    subcommandsOf: (namespace: string): readonly CommandSpec[] =>
      commands.filter((command) => command.name.startsWith(`${namespace} `))
  };
}

function value(name: string, description: string): OptionSpec {
  return { name, kind: "value", description };
}

function flag(name: string, description: string): OptionSpec {
  return { name, kind: "boolean", description };
}

/**
 * The ordered command table from specification section 23. Handlers for
 * subsystems that later tasks deliver are stubs that exit with code 3.
 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "help",
    summary: "Show help for the CLI or for one command.",
    arguments: [
      {
        name: "command",
        description: 'Command name, for example "pack init". Optional.'
      }
    ],
    options: [],
    handler: helpCommand
  },
  {
    name: "version",
    summary: "Print the CLI name and version.",
    arguments: [],
    options: [],
    handler: versionCommand
  },
  {
    name: "inspect",
    summary: "Report source identity: path, media type, digest, size.",
    arguments: [
      {
        name: "source",
        description: 'OpenAPI document or pack; "-" reads standard input.'
      }
    ],
    options: [
      flag(
        "strict",
        "Fail when any operation is not fully supported. Reserved."
      ),
      value(
        "operation",
        "Limit the report to one operation ID or key. Reserved."
      )
    ],
    handler: inspectCommand
  },
  {
    name: "serve",
    summary: "Serve the mock API for a contract or pack.",
    arguments: [
      { name: "source", description: "OpenAPI document or pack directory." }
    ],
    options: [
      value("mode", "Contract or scenario mode."),
      value("scenario", "Scenario ID for scenario mode."),
      value("host", "Bind host; defaults to 127.0.0.1."),
      value("port", "Bind port; zero requests an ephemeral port."),
      value("run-seed", "Direct run seed."),
      value("run-id", "Run ID for the server run."),
      value("run-dir", "Run directory to create."),
      value("resume", "Unfinalized run directory to resume."),
      value("ready", "File that receives the readiness record."),
      value("credentials-out", "Exact path for the credentials file."),
      flag("strict", "Refuse unsupported operations."),
      flag("allow-non-loopback", "Explicitly allow non-loopback binding.")
    ],
    handler: stubCommand("serve")
  },
  {
    name: "pack init",
    summary: "Create a new pack from an OpenAPI document.",
    arguments: [
      { name: "directory", description: "Target directory; must be empty." }
    ],
    options: [value("openapi", "OpenAPI document copied into the pack.")],
    handler: stubCommand("pack init")
  },
  {
    name: "pack validate",
    summary: "Validate one pack directory.",
    arguments: [{ name: "pack", description: "Pack directory." }],
    options: [flag("strict", "Treat warnings as failures.")],
    handler: stubCommand("pack validate")
  },
  {
    name: "eval init",
    summary: "Create a minimal eval inside a pack.",
    arguments: [{ name: "pack", description: "Pack directory." }],
    options: [value("id", "Eval identifier to create.")],
    handler: stubCommand("eval init")
  },
  {
    name: "eval validate",
    summary: "Validate one eval inside a pack.",
    arguments: [{ name: "pack", description: "Pack directory." }],
    options: [
      value("eval", "Eval identifier; defaults to every eval."),
      flag("strict", "Treat warnings as failures.")
    ],
    handler: stubCommand("eval validate")
  },
  {
    name: "run",
    summary: "Run one eval or a cohort of trials.",
    arguments: [{ name: "pack", description: "Pack directory." }],
    options: [
      value("eval", "Eval identifier to run."),
      value("profile", "Run profile document."),
      value("scenario", "Scenario ID overriding the eval default."),
      value("agent", "Agent adapter selector."),
      value("model", "Model identifier."),
      value("effort", "Model effort level."),
      value("exposure", "raw-http, direct-tools, or catalog-tools."),
      value("contract-visibility", "file, discoverable, tool-only, or none."),
      value("data-plane-scope", "all or eval."),
      value("count", "Number of trials."),
      value("parallel", "Number of parallel trials."),
      value("batch", "Batch identifier; must not exist."),
      value("timeout", "Trial timeout duration."),
      value("cohort-seed", "Cohort seed."),
      value("sandbox", "Sandbox mode."),
      flag("yes", "Confirm paid runs without a prompt."),
      flag("dry-run", "Run preflight only; start no agent."),
      flag("no-fail-on-eval", "Map evaluation threshold failure to exit 0.")
    ],
    handler: stubCommand("run")
  },
  {
    name: "evaluate",
    summary: "Evaluate a finished run or batch.",
    arguments: [
      { name: "run-or-batch", description: "Run or batch directory." }
    ],
    options: [value("rubric", "Rubric overriding the frozen one.")],
    handler: stubCommand("evaluate")
  },
  {
    name: "report",
    summary: "Render a report for a run or batch.",
    arguments: [
      { name: "run-or-batch", description: "Run or batch directory." }
    ],
    options: [flag("regrade", "Create a derived evaluation and report.")],
    handler: stubCommand("report")
  },
  {
    name: "compare",
    summary: "Compare two batches descriptively.",
    arguments: [
      { name: "batch-a", description: "First batch directory." },
      { name: "batch-b", description: "Second batch directory." }
    ],
    options: [],
    handler: stubCommand("compare")
  },
  {
    name: "replay",
    summary: "Replay a recorded run without an agent.",
    arguments: [{ name: "run", description: "Run directory." }],
    options: [
      value("request", "Request sequence to replay."),
      flag("verify", "Verify deterministic replay equality.")
    ],
    handler: stubCommand("replay")
  },
  {
    name: "doctor",
    summary: "Check local tool prerequisites without a paid call.",
    arguments: [],
    options: [value("agent", "Adapter executable to probe.")],
    handler: stubCommand("doctor")
  },
  {
    name: "workflow run",
    summary: "Run an Arazzo workflow against a pack as a control run.",
    arguments: [{ name: "pack", description: "Pack directory." }],
    options: [value("workflow", "Workflow identifier.")],
    handler: stubCommand("workflow run")
  },
  {
    name: "study init",
    summary: "Create a new study protocol directory.",
    arguments: [
      { name: "new-study-dir", description: "Target directory; must be empty." }
    ],
    options: [
      value("pack", "Local pack backing the study."),
      value("eval", "Eval identifier."),
      value("id", "Study identifier.")
    ],
    handler: stubCommand("study init")
  },
  {
    name: "study validate",
    summary: "Validate a study protocol and manage its lock.",
    arguments: [{ name: "study-dir", description: "Study directory." }],
    options: [
      value("pack", "Local pack resolving the protocol PackRef."),
      value("phase", "Phase to validate."),
      value("materialize-contracts", "Directory for materialized variants."),
      flag("check-lock", "Fail on protocol drift."),
      flag("write-lock", "Explicitly write the lock.")
    ],
    handler: stubCommand("study validate")
  },
  {
    name: "study schedule",
    summary: "Emit deterministic phase assignments.",
    arguments: [{ name: "study-dir", description: "Study directory." }],
    options: [
      value("phase", "Phase to schedule."),
      value("seed", "Scheduling seed."),
      value("study-run", "StudyRun identifier.")
    ],
    handler: stubCommand("study schedule")
  },
  {
    name: "study run",
    summary: "Run one scheduled study phase.",
    arguments: [{ name: "study-dir", description: "Study directory." }],
    options: [
      value("phase", "Phase to run."),
      value("pack", "Local pack resolving the protocol PackRef."),
      value("schedule", "Candidate assignments document."),
      value("study-run", "StudyRun identifier."),
      value("model", "Model identifier."),
      value("effort", "Model effort level."),
      value("agent", "Agent adapter selector."),
      value("sandbox", "Sandbox mode."),
      flag("yes", "Confirm paid launches without a prompt."),
      flag("dry-run", "Validate in a temporary root; launch nothing.")
    ],
    handler: stubCommand("study run")
  },
  {
    name: "study analyze",
    summary: "Analyze a finished study run.",
    arguments: [{ name: "study-run-dir", description: "StudyRun directory." }],
    options: [
      value("analysis-plan", "Frozen derived analysis plan."),
      value("include-study-run", "Additional compatible StudyRun directory.")
    ],
    handler: stubCommand("study analyze")
  }
];

export const COMMAND_REGISTRY: CommandRegistry =
  createCommandRegistry(COMMANDS);
