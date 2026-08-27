import { describe, expect, it } from "vitest";

import {
  ArazzoExpressionError,
  evaluateCriterion,
  evaluateOperand,
  evaluateRuntimeSource,
  parseCriterion,
  parseRuntimeExpression,
  parseTemplate,
  type ArazzoExpressionLimits,
  type CriterionNode,
  type OperandNode,
  type RuntimeContext
} from "./expressions.ts";

function leftOperand(node: CriterionNode): OperandNode {
  if (node.node === "compare") {
    return node.left;
  }
  throw new Error("The criterion was expected to be a comparison.");
}

function context(init: Partial<RuntimeContext> = {}): RuntimeContext {
  return {
    url: "https://api.steel.test/v1/computers",
    statusCode: 201,
    requestBody: { template: "system/chrome" },
    responseBody: {
      id: "c_1",
      template: "system/chrome",
      sha256: "aa00",
      nested: { file_id: "f_1" }
    },
    inputs: { label: "recovery-run", retries: 2 },
    stepOutputs: new Map([["create-computer", { computer_id: "c_1" }]]),
    ...init
  };
}

function failure(run: () => unknown): ArazzoExpressionError {
  try {
    run();
  } catch (caught) {
    if (caught instanceof ArazzoExpressionError) {
      return caught;
    }
    throw caught;
  }
  throw new Error("The expression was expected to fail.");
}

describe("parseRuntimeExpression", () => {
  it("accepts every supported source", () => {
    expect(parseRuntimeExpression("$url")).toEqual({ kind: "url" });
    expect(parseRuntimeExpression("$statusCode")).toEqual({
      kind: "status_code"
    });
    expect(parseRuntimeExpression("$response.body")).toEqual({
      kind: "response_body",
      pointer: ""
    });
    expect(parseRuntimeExpression("$response.body#/sha256")).toEqual({
      kind: "response_body",
      pointer: "/sha256"
    });
    expect(parseRuntimeExpression("$request.body#/template")).toEqual({
      kind: "request_body",
      pointer: "/template"
    });
    expect(parseRuntimeExpression("$inputs.label")).toEqual({
      kind: "input",
      name: "label",
      pointer: ""
    });
    expect(parseRuntimeExpression("$inputs.label#/deep/0")).toEqual({
      kind: "input",
      name: "label",
      pointer: "/deep/0"
    });
    expect(
      parseRuntimeExpression("$outputs.create-computer.computer_id")
    ).toEqual({
      kind: "step_output",
      stepId: "create-computer",
      name: "computer_id",
      pointer: ""
    });
    expect(
      parseRuntimeExpression("$steps.create-computer.outputs.computer_id#/id")
    ).toEqual({
      kind: "step_output",
      stepId: "create-computer",
      name: "computer_id",
      pointer: "/id"
    });
  });

  it("rejects every source outside the subset", () => {
    const unsupported = [
      "$method",
      "$request.path.computer_id",
      "$request.query.limit",
      "$response.headers.x-request-id",
      "$response.header.x-id",
      "$message.body#/id",
      "$workflows.recovery.inputs.label",
      "$sourceDescriptions.steel-contract.createComputer",
      "$components.parameters.page",
      "$self"
    ];
    for (const text of unsupported) {
      expect(failure(() => parseRuntimeExpression(text)).code).toBe(
        "ARZZO-EXPRESSION-UNSUPPORTED"
      );
    }
  });

  it("rejects malformed expressions", () => {
    expect(failure(() => parseRuntimeExpression("status_code")).code).toBe(
      "ARZZO-EXPRESSION-INVALID"
    );
    expect(failure(() => parseRuntimeExpression("$inputs.")).code).toBe(
      "ARZZO-EXPRESSION-INVALID"
    );
    expect(failure(() => parseRuntimeExpression("$steps.a.name")).code).toBe(
      "ARZZO-EXPRESSION-UNSUPPORTED"
    );
    expect(failure(() => parseRuntimeExpression("$inputs.x#id")).code).toBe(
      "ARZZO-EXPRESSION-INVALID"
    );
  });

  it("enforces the length limit", () => {
    const limits: ArazzoExpressionLimits = {
      maxSourceLength: 8,
      maxDepth: 8,
      maxSteps: 100
    };
    expect(
      failure(() => parseRuntimeExpression("$inputs.veryLongName", limits)).code
    ).toBe("ARZZO-EXPRESSION-LENGTH");
  });
});

describe("parseTemplate", () => {
  it("splits literal and interpolated parts", () => {
    expect(
      parseTemplate("sha256:{$steps.create-computer.outputs.computer_id}#1")
    ).toEqual([
      { literal: "sha256:" },
      {
        expression: "$steps.create-computer.outputs.computer_id",
        source: {
          kind: "step_output",
          stepId: "create-computer",
          name: "computer_id",
          pointer: ""
        }
      },
      { literal: "#1" }
    ]);
  });

  it("rejects an interpolation outside the subset", () => {
    expect(failure(() => parseTemplate("{$workflows.w.inputs.x}")).code).toBe(
      "ARZZO-EXPRESSION-UNSUPPORTED"
    );
    expect(failure(() => parseTemplate("{$inputs.x")).code).toBe(
      "ARZZO-EXPRESSION-INVALID"
    );
  });
});

describe("evaluateRuntimeSource", () => {
  it("resolves every supported source", () => {
    const ctx = context();
    expect(evaluateRuntimeSource(parseRuntimeExpression("$url"), ctx)).toBe(
      "https://api.steel.test/v1/computers"
    );
    expect(
      evaluateRuntimeSource(parseRuntimeExpression("$statusCode"), ctx)
    ).toBe(201);
    expect(
      evaluateRuntimeSource(
        parseRuntimeExpression("$response.body#/sha256"),
        ctx
      )
    ).toBe("aa00");
    expect(
      evaluateRuntimeSource(
        parseRuntimeExpression("$response.body#/nested/file_id"),
        ctx
      )
    ).toBe("f_1");
    expect(
      evaluateRuntimeSource(
        parseRuntimeExpression("$request.body#/template"),
        ctx
      )
    ).toBe("system/chrome");
    expect(
      evaluateRuntimeSource(parseRuntimeExpression("$inputs.label"), ctx)
    ).toBe("recovery-run");
    expect(
      evaluateRuntimeSource(
        parseRuntimeExpression("$outputs.create-computer.computer_id"),
        ctx
      )
    ).toBe("c_1");
    expect(
      evaluateRuntimeSource(
        parseRuntimeExpression("$steps.create-computer.outputs.computer_id"),
        ctx
      )
    ).toBe("c_1");
  });

  it("resolves a missing value to null", () => {
    const ctx = context({
      statusCode: null,
      responseBody: null,
      stepOutputs: new Map()
    });
    expect(
      evaluateRuntimeSource(parseRuntimeExpression("$statusCode"), ctx)
    ).toBeNull();
    expect(
      evaluateRuntimeSource(parseRuntimeExpression("$response.body#/id"), ctx)
    ).toBeNull();
    expect(
      evaluateRuntimeSource(
        parseRuntimeExpression("$steps.missing.outputs.x"),
        ctx
      )
    ).toBeNull();
    expect(
      evaluateRuntimeSource(parseRuntimeExpression("$inputs.missing"), ctx)
    ).toBeNull();
    expect(
      evaluateRuntimeSource(
        parseRuntimeExpression("$response.body#/absent"),
        context()
      )
    ).toBeNull();
  });
});

describe("evaluateCriterion operators", () => {
  it("compares equality and inequality", () => {
    expect(
      evaluateCriterion(parseCriterion("$statusCode == 201"), context()).passed
    ).toBe(true);
    expect(
      evaluateCriterion(parseCriterion("$statusCode != 201"), context()).passed
    ).toBe(false);
    expect(
      evaluateCriterion(
        parseCriterion('$response.body#/template == "system/chrome"'),
        context()
      ).passed
    ).toBe(true);
    expect(
      evaluateCriterion(parseCriterion("$statusCode == 200"), context()).passed
    ).toBe(false);
  });

  it("compares order for numbers and strings", () => {
    expect(
      evaluateCriterion(parseCriterion("$statusCode >= 201"), context()).passed
    ).toBe(true);
    expect(
      evaluateCriterion(parseCriterion("$statusCode > 201"), context()).passed
    ).toBe(false);
    expect(
      evaluateCriterion(parseCriterion("$statusCode < 400"), context()).passed
    ).toBe(true);
    expect(
      evaluateCriterion(parseCriterion("$statusCode <= 200"), context()).passed
    ).toBe(false);
    expect(
      evaluateCriterion(parseCriterion('$response.body#/id < "c_2"'), context())
        .passed
    ).toBe(true);
  });

  it("supports boolean and, or, and not", () => {
    const criterion = parseCriterion(
      '$statusCode == 201 && $response.body#/template == "system/chrome" && !($statusCode == 200)'
    );
    expect(evaluateCriterion(criterion, context()).passed).toBe(true);
    expect(
      evaluateCriterion(
        parseCriterion("$statusCode == 200 || $statusCode == 201"),
        context()
      ).passed
    ).toBe(true);
    expect(
      evaluateCriterion(parseCriterion("!($statusCode == 201)"), context())
        .passed
    ).toBe(false);
  });

  it("rejects an ordering comparison across types", () => {
    const outcome = evaluateCriterion(
      parseCriterion("$statusCode > true"),
      context()
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toBe(
      "Ordering comparisons need two numbers or two strings on either side."
    );
  });

  it("rejects a bare non-boolean operand", () => {
    const outcome = evaluateCriterion(parseCriterion("$statusCode"), context());
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toBe("A bare criterion operand must be a boolean.");
  });

  it("rejects identifiers and unknown syntax", () => {
    expect(failure(() => parseCriterion("status == 200")).code).toBe(
      "ARZZO-EXPRESSION-INVALID"
    );
    expect(failure(() => parseCriterion("$statusCode == ")).code).toBe(
      "ARZZO-EXPRESSION-INVALID"
    );
    expect(failure(() => parseCriterion("$statusCode == 201 extra")).code).toBe(
      "ARZZO-EXPRESSION-INVALID"
    );
    expect(failure(() => parseCriterion("($statusCode == 201")).code).toBe(
      "ARZZO-EXPRESSION-INVALID"
    );
  });
});

describe("interpolation", () => {
  it("evaluates a single-expression operand to the raw value", () => {
    expect(
      evaluateOperand(
        leftOperand(parseCriterion("{$statusCode} == 201")),
        context()
      )
    ).toBe(201);
  });

  it("concatenates literal and expression parts", () => {
    expect(
      evaluateOperand(
        leftOperand(parseCriterion('"sha256:{$response.body#/sha256}" == "x"')),
        context()
      )
    ).toBe("sha256:aa00");
    expect(
      evaluateOperand(
        leftOperand(
          parseCriterion("'a{$statusCode}b{$inputs.retries}' == 'x'")
        ),
        context()
      )
    ).toBe("a201b2");
  });

  it("serializes structures as JSON", () => {
    expect(
      evaluateOperand(
        leftOperand(parseCriterion('"body={$request.body}" == "x"')),
        context()
      )
    ).toBe('body={"template":"system/chrome"}');
    expect(
      evaluateOperand(
        leftOperand(parseCriterion("'x{$statusCode}y' == 1")),
        context()
      )
    ).toBe("x201y");
  });

  it("compares two interpolated operands", () => {
    const criterion = parseCriterion(
      "{$response.body#/sha256} == {$inputs.label}"
    );
    expect(
      evaluateCriterion(criterion, context({ inputs: { label: "aa00" } }))
        .passed
    ).toBe(true);
  });

  it("rejects an interpolation without an expression", () => {
    expect(failure(() => parseCriterion("{literal} == 1")).code).toBe(
      "ARZZO-EXPRESSION-INVALID"
    );
  });
});

describe("expression limits", () => {
  const limits: ArazzoExpressionLimits = {
    maxSourceLength: 2048,
    maxDepth: 4,
    maxSteps: 3
  };

  it("enforces the depth limit", () => {
    expect(
      failure(() => parseCriterion("!!!!!!($statusCode == 1)", limits)).code
    ).toBe("ARZZO-EXPRESSION-DEPTH");
  });

  it("enforces the step budget", () => {
    const outcome = evaluateCriterion(
      parseCriterion("$statusCode == 201 && $statusCode == 201"),
      context(),
      limits
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toBe("The evaluation exceeded the step budget.");
  });
});
