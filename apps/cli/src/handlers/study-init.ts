/**
 * `oal study init` (specification section 23.14). The scaffold writes a
 * minimal schema-valid StudyProtocol that references one local pack by
 * identity only, a non-analytical smoke PhasePlan, a run-profile member,
 * a participant-surface policy, an analysis-plan placeholder, and a
 * README. The protocol schema demands one factor and one metric, so the
 * scaffold declares one nuisance factor with two levels that vary
 * nothing, and sources its metric from the first rubric check of the
 * requested eval. It invents no hypothesis, effect size, or claim.
 */

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EXIT_OK,
  invalidInput,
  isSafeId,
  stableJsonStringify,
  type Json
} from "@oal/core";
import { loadRubric } from "@oal/evaluator";
import { parsePackDocument } from "@oal/pack";

import type { CommandHandler } from "../commands.ts";
import { missingArgument, tooManyArguments } from "../usage.ts";
import {
  packIdentityOf,
  StudyCliCode,
  evalEntryOf,
  packFileText
} from "./study-tree.ts";

/** Stable diagnostic codes of the init command. */
export const InitCode = {
  TargetNotEmpty: "OAL-STUDY-INIT-TARGET-NOT-EMPTY",
  IdUnsafe: "OAL-STUDY-INIT-ID-UNSAFE",
  PackMissing: "OAL-STUDY-INIT-PACK-MISSING",
  EvalUnknown: "OAL-STUDY-INIT-EVAL-UNKNOWN",
  RubricUnavailable: "OAL-STUDY-INIT-RUBRIC-UNAVAILABLE"
} as const;

/** One scaffold result, reported to the caller. */
export interface StudyScaffold {
  readonly root: string;
  readonly id: string;
  readonly files: readonly string[];
}

/** The placeholder factor the scaffold declares. The README documents it. */
export const SCAFFOLD_FACTOR = "scaffold";

/** The identifier of the smoke phase the scaffold writes. */
export const SCAFFOLD_PHASE = "smoke";

/** Read the metric source of the scaffold: the first rubric check. */
async function firstRubricCheckOf(
  packRoot: string,
  evalId: string
): Promise<string> {
  const identity = await packIdentityOf(packRoot);
  const entry = evalEntryOf(identity.pack, evalId);
  if (entry === null) {
    throw invalidInput(
      InitCode.EvalUnknown,
      `Pack ${identity.pack.root} declares no eval "${evalId}".`
    );
  }
  const rubricPath =
    typeof entry["rubric"] === "string" ? entry["rubric"] : null;
  if (rubricPath === null) {
    throw invalidInput(
      InitCode.RubricUnavailable,
      `Eval ${evalId} of ${identity.pack.root} declares no rubric path.`
    );
  }
  const text = await packFileText(identity.pack, rubricPath);
  if (text === null) {
    throw invalidInput(
      InitCode.RubricUnavailable,
      `Rubric ${rubricPath} of pack ${identity.pack.root} is missing.`
    );
  }
  const parsed = parsePackDocument(text, rubricPath);
  if (parsed.value === null) {
    throw invalidInput(
      InitCode.RubricUnavailable,
      `Rubric ${rubricPath} of pack ${identity.pack.root} is not readable.`
    );
  }
  const rubric = await loadRubric(parsed.value, { documentUri: rubricPath });
  const first = rubric.rubric?.checks[0]?.id;
  if (rubric.rubric === null || first === undefined) {
    throw invalidInput(
      InitCode.RubricUnavailable,
      `Rubric ${rubricPath} of eval ${evalId} holds no check.`
    );
  }
  return first;
}

/** The scenario identifier the requested eval declares. */
async function scenarioIdOf(packRoot: string, evalId: string): Promise<string> {
  const identity = await packIdentityOf(packRoot);
  const entry = evalEntryOf(identity.pack, evalId);
  const scenario =
    entry === null
      ? null
      : typeof entry["scenario"] === "string"
        ? entry["scenario"]
        : null;
  return scenario ?? "baseline";
}

/** The StudyProtocol document of the scaffold. */
export function protocolDocument(input: {
  readonly id: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly packSha256: string;
  readonly evalId: string;
  readonly scenarioId: string;
  readonly metricId: string;
}): Json {
  return {
    apiVersion: "agentlab.dev/v1",
    kind: "StudyProtocol",
    metadata: {
      id: input.id,
      version: "0.1.0",
      title: `${input.id} scaffold`
    },
    objective:
      "Scaffold study. Replace this objective, the factor, and the " +
      "metrics before any analytical run.",
    evaluation: {
      pack: {
        id: input.packId,
        version: input.packVersion,
        sha256: input.packSha256
      },
      eval: input.evalId,
      scenario: input.scenarioId
    },
    factors: [
      {
        id: SCAFFOLD_FACTOR,
        role: "nuisance",
        levels: [{ id: "level-a" }, { id: "level-b" }]
      }
    ],
    constants: {
      run_profile: "profiles/smoke.yaml"
    },
    metrics: {
      primary: [
        {
          id: input.metricId,
          type: "binary",
          source: { kind: "rubric_check", check_id: input.metricId }
        }
      ]
    },
    blinding: {
      mode: "none",
      participant_surface_policy: "blinding/participant-surface.yaml"
    },
    phases: {
      smoke: "phases/smoke.yaml"
    },
    interpretation_limits: [
      "This scaffold is a smoke study and supports no analytical claim.",
      "The placeholder factor exists only because the protocol schema " +
        "requires one factor; it varies nothing."
    ],
    extensions: {}
  };
}

/** The non-analytical smoke PhasePlan of the scaffold. */
export function smokePhaseDocument(metricId: string): Json {
  return {
    apiVersion: "agentlab.dev/v1",
    kind: "PhasePlan",
    metadata: { id: SCAFFOLD_PHASE },
    purpose: "smoke",
    analytical: false,
    design: {
      kind: "complete-balanced-blocks",
      primary_assignments: 2,
      block: { cells: "all", repetitions: 1 },
      ordering: "canonical-sha256-sort-v1"
    },
    runtime_lock: {
      required_fields: ["agent.adapter"]
    },
    eligibility: {
      primary_agent_outcome: {
        require: "participant_control_started"
      },
      api_behavior: {
        require: ["participant_control_started", "trace_intact"]
      }
    },
    stopping: {
      batch_wide_pre_control_failure: "abort",
      second_unreplaced_failure_in_cell: "incomplete",
      operator_interruption: "abort",
      data_dependent_success_stop: "forbidden"
    },
    analysis: {
      contrasts: [
        {
          id: "scaffold_contrast",
          metric: metricId,
          factor: SCAFFOLD_FACTOR,
          levels: ["level-a", "level-b"],
          direction: "first_minus_second"
        }
      ],
      primary_estimand: {
        id: "scaffold_estimand",
        outcome: metricId,
        population: "primary_agent_outcome",
        contrast: "scaffold_contrast",
        measure: "risk_difference"
      },
      comparison_families: [
        {
          id: "scaffold_family",
          contrasts: ["scaffold_contrast"],
          alpha: 0.05,
          multiplicity: "holm"
        }
      ],
      methods: {
        binary_interval: "wilson",
        risk_difference_interval: "newcombe",
        exact_test: "fisher_two_sided"
      },
      sensitivity: {
        participant_control_started_censors_as_failure: true
      },
      marginal_weighting: "none",
      floor_ceiling: { apply_by_factor_level: null },
      small_sample_label: "directional"
    },
    paid_calls: { primary: 2, maximum_with_replacements: 2 }
  };
}

/** The run-profile member of the scaffold. */
export function runProfileDocument(): string {
  return [
    "apiVersion: agentlab.dev/v1",
    "kind: RunProfile",
    "metadata:",
    `  id: ${SCAFFOLD_PHASE}`,
    "agent:",
    "  adapter: generic",
    "  model: null",
    "  effort: null",
    "  sandbox: null",
    "exposure:",
    "  mode: raw-http",
    "  contract_visibility: file",
    "  data_plane_scope: all",
    "  documentation_profile: null",
    "execution:",
    "  count: 1",
    "  parallel: 1",
    "  timeout_ms: 300000",
    '  cohort_seed: ""',
    "  confirm_paid_calls: false",
    "evaluation:",
    "  model_judge: disabled",
    "  fail_on:",
    "    required_check: true",
    "    infrastructure: true",
    "limits:",
    "  max_agent_tool_calls: 200",
    "  max_api_requests: 1000",
    "  max_artifact_bytes: 104857600",
    ""
  ].join("\n");
}

/** The participant-surface policy member of the scaffold. */
export function surfacePolicyDocument(id: string): string {
  return stableJsonStringify({
    schema_version: 1,
    kind: "ParticipantSurfacePolicy",
    id: "surface-policy",
    version: "0.1.0",
    forbidden_literals: [],
    forbidden_patterns: [],
    allowed_exceptions: [],
    treatment_owned: {
      paths: [],
      routes: [],
      fields: [],
      catalogs: []
    },
    neutral_profiles: {
      response_profile: `${id}-responses`,
      credential_profile: `${id}-credentials`,
      server_profile: `${id}-server`
    },
    pairwise_surface_diff_allowlist: [],
    required_reviews: {
      equivalence: false,
      blinding: false
    },
    extensions: {}
  } as unknown as Json);
}

/** The analysis-plan placeholder of the scaffold. */
export function analysisPlanPlaceholder(): string {
  return [
    "# Analysis plan placeholder",
    "",
    "The frozen analysis plan of an analytical phase belongs here. The",
    "scaffold writes none, because a smoke phase claims nothing.",
    ""
  ].join("\n");
}

/** The README of the scaffold. */
export function readmeDocument(input: {
  readonly id: string;
  readonly packDir: string;
  readonly evalId: string;
  readonly metricId: string;
}): string {
  return [
    `# Study ${input.id}`,
    "",
    "This directory is a scaffold. It records one local pack by identity",
    "(ID, version, freeze digest) and nothing else about the host.",
    "",
    "Members:",
    "",
    "- `study.yaml` - the StudyProtocol.",
    "- `phases/smoke.yaml` - a non-analytical smoke PhasePlan.",
    "- `profiles/smoke.yaml` - the run profile the protocol locks.",
    "- `blinding/participant-surface.yaml` - the participant-surface policy.",
    "- `analysis/plan.placeholder.md` - the analysis-plan placeholder.",
    "",
    "Before any analytical run you must:",
    "",
    "1. Replace the objective with the real research question.",
    `2. Replace the placeholder factor "${SCAFFOLD_FACTOR}". The protocol`,
    "   schema requires one factor, so the scaffold declares a nuisance",
    "   factor with two levels. It varies nothing.",
    `3. Replace or confirm the metric "${input.metricId}", which points at`,
    `   the first rubric check of eval "${input.evalId}".`,
    "4. Write a real PhasePlan and the frozen analysis plan.",
    "5. Run `oal study validate --pack <pack> --write-lock` to lock the",
    "   protocol. The lock lands in `protocol.lock.json`.",
    "",
    `Pack referenced: ${input.packDir} (identity only; the path is not`,
    "recorded).",
    ""
  ].join("\n");
}

function safeStudyId(candidate: string): string | null {
  return isSafeId(candidate) ? candidate : null;
}

/** Scaffold one study directory. */
export async function scaffoldStudy(
  directory: string,
  options: {
    readonly cwd: string;
    readonly packDir: string;
    readonly evalId: string;
    readonly id: string;
  }
): Promise<StudyScaffold> {
  const root = path.resolve(options.cwd, directory);
  const existing = await stat(root).catch(() => null);
  if (existing !== null && !existing.isDirectory()) {
    throw invalidInput(
      InitCode.TargetNotEmpty,
      `Study target is not a directory: ${root}.`
    );
  }
  if (existing !== null) {
    const entries = await readdir(root);
    if (entries.length > 0) {
      throw invalidInput(
        InitCode.TargetNotEmpty,
        `Study target is not empty: ${root}.`
      );
    }
  }
  const id = safeStudyId(options.id);
  if (id === null) {
    throw invalidInput(
      InitCode.IdUnsafe,
      `Study identifier is not a safe id: ${options.id}.`
    );
  }
  const packRoot = path.resolve(options.cwd, options.packDir);
  const metricId = await firstRubricCheckOf(packRoot, options.evalId);
  const scenarioId = await scenarioIdOf(packRoot, options.evalId);
  const identity = await packIdentityOf(packRoot);
  const protocol = protocolDocument({
    id,
    packId: identity.id,
    packVersion: identity.version,
    packSha256: identity.sha256,
    evalId: options.evalId,
    scenarioId,
    metricId
  });
  const files: ReadonlyArray<readonly [string, string]> = [
    ["study.yaml", yamlOf(protocol)],
    ["phases/smoke.yaml", yamlOf(smokePhaseDocument(metricId))],
    ["profiles/smoke.yaml", runProfileDocument()],
    ["blinding/participant-surface.yaml", surfacePolicyDocument(id)],
    ["analysis/plan.placeholder.md", analysisPlanPlaceholder()],
    [
      "README.md",
      readmeDocument({
        id,
        packDir: packRoot,
        evalId: options.evalId,
        metricId
      })
    ]
  ];
  for (const [relative] of files) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  }
  await mkdir(root, { recursive: true });
  for (const [relative, contents] of files) {
    await writeFile(path.join(root, relative), contents);
  }
  return { root, id, files: files.map(([relative]) => relative) };
}

/**
 * Render one scaffold document as YAML. Every scaffold document is JSON
 * shaped, so a stable pretty-printed JSON block inside a YAML text is a
 * valid YAML mapping and stays diff-friendly.
 */
function yamlOf(document: Json): string {
  const text = stableJsonStringify(document);
  return `${text}\n`;
}

/** `oal study init <dir> --pack <pack> --eval <id> --id <id>`. */
export const studyInitCommand: CommandHandler = async (args, io) => {
  const directory = args.positionals[0];
  if (directory === undefined) {
    throw missingArgument(args.command.name, "new-study-dir");
  }
  if (args.positionals.length > 1) {
    throw tooManyArguments(args.command.name, 1);
  }
  const packDir = args.flags.string("pack");
  if (packDir === undefined) {
    throw invalidInput(
      InitCode.PackMissing,
      'Command "study init" requires --pack with a local pack directory.'
    );
  }
  const evalId = args.flags.string("eval");
  if (evalId === undefined) {
    throw invalidInput(
      StudyCliCode.EvalMissing,
      'Command "study init" requires --eval with an eval of that pack.'
    );
  }
  const idFlag = args.flags.string("id");
  const id = idFlag ?? path.basename(path.resolve(args.context.cwd, directory));
  const result = await scaffoldStudy(directory, {
    cwd: args.context.cwd,
    packDir,
    evalId,
    id
  });
  if (args.context.format === "json") {
    io.stdout(
      stableJsonStringify({
        root: result.root,
        id: result.id,
        files: [...result.files]
      } as Json)
    );
  } else {
    io.stdout(`created: ${result.root}`);
    io.stdout(`study id: ${result.id}`);
    for (const file of result.files) {
      io.stdout(`file: ${file}`);
    }
  }
  return EXIT_OK;
};
