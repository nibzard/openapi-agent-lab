/**
 * Test fixture: a stateful counter backend served over the child
 * protocol. Used by host tests through a real child process. A JSON
 * request body of {"fail": true} triggers a declared HTTP error so
 * tests can check error propagation.
 */

import {
  BehaviorHttpError,
  type BackendModule,
  type BehaviorBackend,
  type BehaviorRequest,
  type BehaviorResult,
  type HandleContext,
  type InitializeResult
} from "@oal/behavior-api";
import { runBehaviorChild } from "./child.ts";

const backend: BehaviorBackend = {
  describe() {
    return Promise.resolve({
      backendApiVersion: 1,
      stateSchemaVersion: 1,
      operations: [{ key: "path:POST /count", support: "implemented" }]
    });
  },
  initialize(): Promise<InitializeResult> {
    return Promise.resolve({ state: { count: 0 } });
  },
  handle(
    request: BehaviorRequest,
    context: HandleContext
  ): Promise<BehaviorResult> {
    const state = context.state as { count?: number };
    const signal = request.body.kind === "json" ? request.body.value : null;
    const fail =
      signal !== null &&
      typeof signal === "object" &&
      !Array.isArray(signal) &&
      signal.fail === true;
    if (fail) {
      return Promise.reject(
        new BehaviorHttpError({
          status: 400,
          code: "fixture_refused",
          message: "The fixture was asked to fail.",
          body: { kind: "json", value: { refused: true } }
        })
      );
    }
    const count = (state.count ?? 0) + 1;
    return Promise.resolve({
      response: {
        status: 200,
        mediaType: "application/json",
        body: { kind: "json", value: { count } }
      },
      nextState: { count }
    });
  }
};

const module: BackendModule = {
  apiVersion: 1,
  name: "counter-fixture",
  version: "0.1.0",
  create() {
    return Promise.resolve(backend);
  }
};

void (async () => {
  await runBehaviorChild(module);
})();
