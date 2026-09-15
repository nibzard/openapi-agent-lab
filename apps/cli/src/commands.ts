import type { ExitCode } from "@oal/core";

import type { FlagView, OptionSpec } from "./argv.ts";
import type { RunContext } from "./context.ts";
import { compareCommand } from "./handlers/compare.ts";
import {
  evalInitCommand,
  evalListCommand,
  evalValidateCommand
} from "./handlers/eval.ts";
import { doctorCommand } from "./handlers/doctor.ts";
import { frictionCommand } from "./handlers/friction.ts";
import { evaluateCommand } from "./handlers/evaluate.ts";
import { inspectCommand } from "./handlers/inspect.ts";
import { helpCommand, versionCommand } from "./handlers/misc.ts";
import { packInitCommand, packValidateCommand } from "./handlers/pack.ts";
import { probeCommand } from "./handlers/probe.ts";
import { replayCommand } from "./handlers/replay.ts";
import { reportCommand } from "./handlers/report.ts";
import { runCommand } from "./handlers/run.ts";
import { serveCommand } from "./handlers/serve.ts";
import { traceImportCommand } from "./handlers/trace-import.ts";
import { studyAnalyzeCommand } from "./handlers/study-analyze.ts";
import { studyInitCommand } from "./handlers/study-init.ts";
import { studyRunCommand } from "./handlers/study-run.ts";
import { studyScheduleCommand } from "./handlers/study-schedule.ts";
import { studyValidateCommand } from "./handlers/study-validate.ts";
import { workflowCommand } from "./handlers/workflow.ts";
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
    summary: "Report OpenAPI capabilities and source identity.",
    arguments: [
      {
        name: "source",
        description: 'OpenAPI document or pack; "-" reads standard input.'
      }
    ],
    options: [
      flag("strict", "Fail when any operation is not fully supported."),
      value("operation", "Limit the report to one operation ID or key.")
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
    handler: serveCommand
  },
  {
    name: "pack init",
    summary: "Create a new pack from an OpenAPI document.",
    arguments: [
      { name: "directory", description: "Target directory; must be empty." }
    ],
    options: [value("openapi", "OpenAPI document copied into the pack.")],
    handler: packInitCommand
  },
  {
    name: "pack validate",
    summary: "Validate one pack directory.",
    arguments: [{ name: "pack", description: "Pack directory." }],
    options: [flag("strict", "Treat warnings as failures.")],
    handler: packValidateCommand
  },
  {
    name: "eval init",
    summary: "Scaffold a new eval directory.",
    arguments: [
      { name: "directory", description: "Target directory; must be empty." }
    ],
    options: [value("id", "Eval identifier; defaults to the directory name.")],
    handler: evalInitCommand
  },
  {
    name: "eval validate",
    summary: "Validate one eval document.",
    arguments: [
      { name: "path", description: "Eval document or its directory." }
    ],
    options: [flag("strict", "Treat warnings as failures.")],
    handler: evalValidateCommand
  },
  {
    name: "eval list",
    summary: "List the evals a pack declares.",
    arguments: [{ name: "pack", description: "Pack directory." }],
    options: [],
    handler: evalListCommand
  },
  {
    name: "run",
    summary: "Run one eval or a cohort of trials.",
    arguments: [{ name: "pack", description: "Pack directory." }],
    options: [
      value("eval", "Eval identifier to run."),
      value(
        "profile",
        "Run profile document. Not loaded in this build; use flags."
      ),
      value("scenario", "Scenario ID overriding the eval default."),
      value("agent", "Adapter selector: mock-agent or codex-cli."),
      value(
        "agent-script",
        "JSON participant script for the mock agent, by path."
      ),
      value("model", "Model identifier."),
      value("effort", "Model effort level."),
      value("exposure", "raw-http, direct-tools, or catalog-tools."),
      value("contract-visibility", "file, discoverable, tool-only, or none."),
      value("data-plane-scope", "all or eval."),
      value("count", "Number of trials; the ceiling is 100."),
      value("parallel", "Parallel trials; the ceiling is 10."),
      value("batch", "Batch identifier; defaults to a UTC timestamp."),
      value("timeout", "Trial timeout, for example 30s or 10m."),
      value("cohort-seed", "Cohort seed overriding the derived default."),
      value("sandbox", "Sandbox mode."),
      flag("yes", "Confirm paid runs without a prompt."),
      flag("dry-run", "Run preflight only; start no agent."),
      flag("no-fail-on-eval", "Map evaluation threshold failure to exit 0.")
    ],
    handler: runCommand
  },
  {
    name: "evaluate",
    summary: "Evaluate a finished run or batch.",
    arguments: [
      { name: "run-or-batch", description: "Run or batch directory." }
    ],
    options: [value("rubric", "Rubric overriding the frozen one.")],
    handler: evaluateCommand
  },
  {
    name: "report",
    summary: "Render a report for a run or batch.",
    arguments: [
      { name: "run-or-batch", description: "Run or batch directory." }
    ],
    options: [
      value(
        "rubric",
        "Rubric for --regrade; the run tree alone cannot re-grade."
      ),
      flag("regrade", "Create a derived evaluation and report.")
    ],
    handler: reportCommand
  },
  {
    name: "compare",
    summary: "Compare two batches descriptively.",
    arguments: [
      { name: "batch-a", description: "First batch or report file." },
      { name: "batch-b", description: "Second batch or report file." }
    ],
    options: [],
    handler: compareCommand
  },
  {
    name: "friction",
    summary: "Analyze recorded trials for deterministic API friction.",
    arguments: [
      {
        name: "run-or-batch",
        description: "Run, batch, or serve session directory."
      }
    ],
    options: [],
    handler: frictionCommand
  },
  {
    name: "trace import",
    summary: "Normalize a HAR recording into a serve session trace.",
    arguments: [
      { name: "har", description: 'HAR file; "-" reads standard input.' }
    ],
    options: [
      value("contract", "OpenAPI document or pack the HAR is matched against."),
      value("run-id", "Run ID of the imported session; defaults to a digest.")
    ],
    handler: traceImportCommand
  },
  {
    name: "replay",
    summary: "Replay a recorded run without an agent.",
    arguments: [
      {
        name: "run",
        description: "Run directory below .oal/runs/<batch>/trials/<run-id>."
      }
    ],
    options: [
      value(
        "request",
        "Ingress sequence to replay; the default replays every request."
      ),
      flag(
        "verify",
        "Treat a difference from the record as an error; exit status 2."
      )
    ],
    handler: replayCommand
  },
  {
    name: "probe",
    summary: "Diff a live service against a recorded run contract.",
    arguments: [
      {
        name: "run-or-batch",
        description: "Run or batch directory with a frozen contract."
      }
    ],
    options: [
      value("base-url", "Live base url the recorded requests replay to."),
      value(
        "operations",
        "Comma-separated operation ids or keys; only these replay."
      ),
      value(
        "credential-env",
        "Environment variable holding the request credential."
      ),
      value("timeout", "Per-request timeout, for example 5s or 500ms."),
      flag(
        "allow-writes",
        "Also replay recorded POST, PUT, PATCH, and DELETE requests."
      )
    ],
    handler: probeCommand
  },
  {
    name: "doctor",
    summary: "Check local tool prerequisites without a paid call.",
    arguments: [],
    options: [
      value("agent", "Adapter selector to probe; the default is mock-agent.")
    ],
    handler: doctorCommand
  },
  {
    name: "workflow run",
    summary: "Align an Arazzo workflow with a recorded run.",
    arguments: [{ name: "pack", description: "Pack directory." }],
    options: [
      value("workflow", "Workflow identifier; required when several exist."),
      value("run", "Recorded run directory to align against.")
    ],
    handler: workflowCommand
  },
  {
    name: "study init",
    summary: "Create a new study protocol directory.",
    arguments: [
      { name: "new-study-dir", description: "Target directory; must be empty." }
    ],
    options: [
      value("pack", "Local pack backing the study; required."),
      value("eval", "Eval identifier of that pack; required."),
      value("id", "Study identifier; defaults to the directory name.")
    ],
    handler: studyInitCommand
  },
  {
    name: "study validate",
    summary: "Validate a study protocol and manage its lock.",
    arguments: [{ name: "study-dir", description: "Study directory." }],
    options: [
      value("pack", "Local pack resolving the protocol PackRef."),
      value("phase", "Phase to validate; the default validates every phase."),
      value("materialize-contracts", "Directory for materialized variants."),
      flag("check-lock", "Fail on protocol drift."),
      flag("write-lock", "Explicitly write the lock.")
    ],
    handler: studyValidateCommand
  },
  {
    name: "study schedule",
    summary: "Emit deterministic phase assignments.",
    arguments: [{ name: "study-dir", description: "Study directory." }],
    options: [
      value("pack", "Local pack resolving the protocol PackRef."),
      value("phase", "Phase to schedule; the default uses the first phase."),
      value("seed", "Scheduling seed; required."),
      value("study-run", "StudyRun identifier; required.")
    ],
    handler: studyScheduleCommand
  },
  {
    name: "study run",
    summary: "Run one scheduled study phase.",
    arguments: [{ name: "study-dir", description: "Study directory." }],
    options: [
      value("phase", "Phase to run; required."),
      value("pack", "Local pack resolving the protocol PackRef."),
      value("schedule", "Candidate assignments document; required."),
      value("study-run", "StudyRun identifier; required."),
      value("model", "Model identifier."),
      value("effort", "Model effort level."),
      value("agent", "Agent adapter selector."),
      value("sandbox", "Sandbox mode."),
      flag("yes", "Confirm paid launches without a prompt."),
      flag("dry-run", "Validate only; print the launch plan, start nothing.")
    ],
    handler: studyRunCommand
  },
  {
    name: "study analyze",
    summary: "Analyze a finished study run.",
    arguments: [{ name: "study-run-dir", description: "StudyRun directory." }],
    options: [
      value(
        "analysis-plan",
        "Refused: this build reads no analysis-plan file."
      ),
      value(
        "derived-from",
        "Parent analysis document; writes a derived corrected result."
      ),
      value("include-study-run", "Additional compatible StudyRun directory.")
    ],
    handler: studyAnalyzeCommand
  }
];

export const COMMAND_REGISTRY: CommandRegistry =
  createCommandRegistry(COMMANDS);
