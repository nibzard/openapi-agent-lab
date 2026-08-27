import type { Json, JsonObject } from "../json.ts";
import { isJsonObject } from "../json.ts";
import {
  appendIndex,
  appendPointer,
  resolveJsonPointer
} from "../jsonpointer.ts";

/** Stable violation record used by gateway validation and rubric checks. */
export interface SchemaViolation {
  pointer: string;
  code: string;
  message: string;
  schema_path: string | null;
}

export interface SchemaValidatorOptions {
  /** Maximum reference/depth traversal. Default 64. */
  maxDepth?: number;
  /**
   * Format names asserted instead of annotated. Unknown formats are never
   * asserted. Default: none (annotation-only).
   */
  assertFormats?: ReadonlySet<string> | readonly string[];
  /** Optional resolver for references outside the root schema document. */
  resolveRef?: (ref: string) => Json | undefined;
}

const FORMATS: Record<string, RegExp> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  "date-time":
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  time: /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  duration:
    /^P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  hostname:
    /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/,
  ipv4: /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
  ipv6: /^[0-9a-fA-F:]+$/,
  uri: /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]*$/,
  "uri-reference": /^([a-zA-Z][a-zA-Z0-9+.-]*:)?(\/\/)?[^\s]*$/,
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  byte: /^[A-Za-z0-9+/]*={0,2}$/
};

const NUMERIC_FORMAT_BOUNDS: Record<string, [number, number]> = {
  int32: [-2147483648, 2147483647],
  int64: [-9007199254740991, 9007199254740991],
  float: [-3.4028234663852886e38, 3.4028234663852886e38],
  double: [-Number.MAX_VALUE, Number.MAX_VALUE]
};

const TYPE_OF = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "string",
  "number",
  "integer"
]);

function typeOf(value: Json): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "string":
      return "string";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

function typeMatches(value: Json, type: string): boolean {
  const actual = typeOf(value);
  if (type === "number") {
    return actual === "number" || actual === "integer";
  }
  return actual === type;
}

function stableStringifyScalar(value: Json): string {
  if (
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return JSON.stringify(value);
  }
  return JSON.stringify(value);
}

/**
 * Draft 2020-12 core subset validator with OpenAPI-compatible semantics.
 * Formats are annotations unless explicitly asserted. Violations carry
 * stable codes and instance pointers.
 */
export class SchemaValidator {
  private readonly root: Json;
  private readonly maxDepth: number;
  private readonly assertFormats: ReadonlySet<string>;
  private readonly resolveRef: (ref: string) => Json | undefined;

  constructor(root: Json, options: SchemaValidatorOptions = {}) {
    this.root = root;
    this.maxDepth = options.maxDepth ?? 64;
    this.assertFormats =
      options.assertFormats === undefined
        ? new Set<string>()
        : new Set(options.assertFormats);
    this.resolveRef = options.resolveRef ?? (() => undefined);
  }

  /**
   * Validate `instance` against `schema`. Returns stable violations; an
   * empty array means the instance is valid.
   */
  validate(schema: Json, instance: Json): SchemaViolation[] {
    const violations: SchemaViolation[] = [];
    this.validateNode(schema, instance, "", 0, violations, new Set());
    return violations;
  }

  isValid(schema: Json, instance: Json): boolean {
    return this.validate(schema, instance).length === 0;
  }

  /**
   * Validate `instance` against the root schema supplied at construction.
   * Convenience for request and artifact validation sites.
   */
  errors(instance: Json): SchemaViolation[] {
    return this.validate(this.root, instance);
  }

  private validateNode(
    schema: Json,
    instance: Json,
    pointer: string,
    depth: number,
    violations: SchemaViolation[],
    seen: Set<string>
  ): void {
    if (depth > this.maxDepth) {
      violations.push({
        pointer,
        code: "schema_depth_exceeded",
        message: "Schema traversal depth limit exceeded.",
        schema_path: null
      });
      return;
    }
    if (!isJsonObject(schema)) {
      // A boolean schema or a non-schema value: true allows, false rejects.
      if (schema === false) {
        violations.push({
          pointer,
          code: "schema_false",
          message: "Schema is false; no value is valid.",
          schema_path: null
        });
      }
      return;
    }

    if (typeof schema.$ref === "string") {
      const ref = schema.$ref;
      const refKey = `${ref}@${depth}`;
      if (seen.has(refKey)) {
        // Cyclic reference during validation of cyclic instance data is
        // permitted only when the recursion is finite; JSON data is finite
        // trees, so cycles here come from recursive schemas over equal data
        // and terminate naturally. We do not fail.
      } else {
        seen.add(refKey);
        const target = this.lookupRef(ref);
        if (target === undefined) {
          violations.push({
            pointer,
            code: "ref_not_found",
            message: `Unresolvable schema reference ${ref}.`,
            schema_path: null
          });
          return;
        }
        this.validateNode(
          target,
          instance,
          pointer,
          depth + 1,
          violations,
          seen
        );
        seen.delete(refKey);
      }
      return;
    }

    this.validateKeywords(schema, instance, pointer, depth, violations, seen);
  }

  private lookupRef(ref: string): Json | undefined {
    if (ref.startsWith("#")) {
      return resolveJsonPointer(this.root, ref.slice(1));
    }
    return this.resolveRef(ref);
  }

  private validateKeywords(
    schema: JsonObject,
    instance: Json,
    pointer: string,
    depth: number,
    violations: SchemaViolation[],
    seen: Set<string>
  ): void {
    const push = (code: string, message: string, key: string): void => {
      violations.push({
        pointer,
        code,
        message,
        schema_path: `/${key}`
      });
    };

    // type
    const type = schema["type"];
    if (type !== undefined) {
      const types = Array.isArray(type) ? type : [type];
      const ok = types.some(
        (t) =>
          typeof t === "string" && TYPE_OF.has(t) && typeMatches(instance, t)
      );
      if (!ok) {
        push("type", `Expected type ${stableStringifyScalar(type)}.`, "type");
      }
    }

    // enum / const
    const enumValue = schema["enum"];
    if (Array.isArray(enumValue)) {
      const ok = enumValue.some((candidate) =>
        jsonScalarEquals(candidate, instance)
      );
      if (!ok) {
        push("enum", "Value is not one of the allowed enum members.", "enum");
      }
    }
    const constValue = schema["const"];
    if (constValue !== undefined) {
      if (!jsonScalarEquals(constValue, instance)) {
        push("const", "Value does not equal the required const.", "const");
      }
    }

    // numbers
    if (typeof instance === "number") {
      const multipleOf = schema["multipleOf"];
      if (typeof multipleOf === "number" && multipleOf > 0) {
        const quotient = instance / multipleOf;
        const epsilon = Math.abs(quotient) * 1e-9;
        if (Math.abs(quotient - Math.round(quotient)) > epsilon) {
          push(
            "multipleOf",
            `Value is not a multiple of ${multipleOf}.`,
            "multipleOf"
          );
        }
      }
      const maximum = schema["maximum"];
      if (typeof maximum === "number" && instance > maximum) {
        push("maximum", `Value must be <= ${maximum}.`, "maximum");
      }
      const minimum = schema["minimum"];
      if (typeof minimum === "number" && instance < minimum) {
        push("minimum", `Value must be >= ${minimum}.`, "minimum");
      }
      const exclusiveMaximum = schema["exclusiveMaximum"];
      if (
        typeof exclusiveMaximum === "number" &&
        instance >= exclusiveMaximum
      ) {
        push(
          "exclusiveMaximum",
          `Value must be < ${exclusiveMaximum}.`,
          "exclusiveMaximum"
        );
      }
      const exclusiveMinimum = schema["exclusiveMinimum"];
      if (
        typeof exclusiveMinimum === "number" &&
        instance <= exclusiveMinimum
      ) {
        push(
          "exclusiveMinimum",
          `Value must be > ${exclusiveMinimum}.`,
          "exclusiveMinimum"
        );
      }
    }

    // strings
    if (typeof instance === "string") {
      const maxLength = schema["maxLength"];
      if (typeof maxLength === "number" && instance.length > maxLength) {
        push(
          "maxLength",
          `String length must be <= ${maxLength}.`,
          "maxLength"
        );
      }
      const minLength = schema["minLength"];
      if (typeof minLength === "number" && instance.length < minLength) {
        push(
          "minLength",
          `String length must be >= ${minLength}.`,
          "minLength"
        );
      }
      const pattern = schema["pattern"];
      if (typeof pattern === "string") {
        let re: RegExp | undefined;
        try {
          re = new RegExp(pattern);
        } catch {
          violations.push({
            pointer,
            code: "pattern_invalid",
            message: "Schema pattern is not a supported regular expression.",
            schema_path: "/pattern"
          });
        }
        if (re !== undefined && !re.test(instance)) {
          push(
            "pattern",
            "String does not match the required pattern.",
            "pattern"
          );
        }
      }
      const format = schema["format"];
      if (typeof format === "string") {
        const asserted = this.assertFormats.has(format);
        const matcher = FORMATS[format];
        if (asserted && matcher !== undefined && !matcher.test(instance)) {
          push("format", `String does not match format ${format}.`, "format");
        }
      }
    }

    // numeric formats on numbers
    if (typeof instance === "number" && typeof schema["format"] === "string") {
      const bounds = NUMERIC_FORMAT_BOUNDS[schema["format"]];
      if (bounds !== undefined && this.assertFormats.has(schema["format"])) {
        if (instance < bounds[0] || instance > bounds[1]) {
          push(
            "format",
            `Number is outside the ${schema["format"]} range.`,
            "format"
          );
        }
      }
    }

    // arrays
    if (Array.isArray(instance)) {
      const prefixItems = schema["prefixItems"];
      const items = schema["items"];
      const evaluatedItems = new Set<number>();
      if (Array.isArray(prefixItems)) {
        for (
          let i = 0;
          i < Math.min(prefixItems.length, instance.length);
          i += 1
        ) {
          this.validateNode(
            prefixItems[i] as Json,
            instance[i] as Json,
            appendIndex(pointer, i),
            depth + 1,
            violations,
            seen
          );
          evaluatedItems.add(i);
        }
      }
      if (items !== undefined) {
        const start = Array.isArray(prefixItems) ? prefixItems.length : 0;
        for (let i = start; i < instance.length; i += 1) {
          if (items === false) {
            // Draft 2020-12: `items: false` forbids items beyond prefixItems.
            violations.push({
              pointer: appendIndex(pointer, i),
              code: "items",
              message: "Additional items are not allowed.",
              schema_path: "/items"
            });
            continue;
          }
          this.validateNode(
            items,
            instance[i] as Json,
            appendIndex(pointer, i),
            depth + 1,
            violations,
            seen
          );
          evaluatedItems.add(i);
        }
      }
      const contains = schema["contains"];
      if (contains !== undefined) {
        const minContains =
          typeof schema["minContains"] === "number" ? schema["minContains"] : 1;
        let matchCount = 0;
        for (let i = 0; i < instance.length; i += 1) {
          if (this.isValid(contains, instance[i] as Json)) {
            matchCount += 1;
          }
        }
        if (matchCount < minContains) {
          push(
            "contains",
            "Array does not contain the required number of matching items.",
            "contains"
          );
        }
        const maxContains = schema["maxContains"];
        if (typeof maxContains === "number" && matchCount > maxContains) {
          push(
            "maxContains",
            "Array contains too many matching items.",
            "maxContains"
          );
        }
      }
      const minItems = schema["minItems"];
      if (typeof minItems === "number" && instance.length < minItems) {
        push(
          "minItems",
          `Array must contain >= ${minItems} items.`,
          "minItems"
        );
      }
      const maxItems = schema["maxItems"];
      if (typeof maxItems === "number" && instance.length > maxItems) {
        push(
          "maxItems",
          `Array must contain <= ${maxItems} items.`,
          "maxItems"
        );
      }
      if (schema["uniqueItems"] === true) {
        const seenValues = new Set<string>();
        for (const item of instance) {
          const key = stableStringifyScalar(item);
          if (seenValues.has(key)) {
            push("uniqueItems", "Array items are not unique.", "uniqueItems");
            break;
          }
          seenValues.add(key);
        }
      }
      const unevaluatedItems = schema["unevaluatedItems"];
      if (unevaluatedItems !== undefined && unevaluatedItems !== false) {
        for (let i = 0; i < instance.length; i += 1) {
          if (!evaluatedItems.has(i)) {
            this.validateNode(
              unevaluatedItems,
              instance[i] as Json,
              appendIndex(pointer, i),
              depth + 1,
              violations,
              seen
            );
          }
        }
      }
    }

    // objects
    if (isJsonObject(instance)) {
      const evaluatedProperties = new Set<string>();
      const properties = schema["properties"];
      if (isJsonObject(properties)) {
        for (const key of Object.keys(properties)) {
          if (Object.hasOwn(instance, key)) {
            this.validateNode(
              properties[key] as Json,
              instance[key] as Json,
              appendPointer(pointer, key),
              depth + 1,
              violations,
              seen
            );
            evaluatedProperties.add(key);
          }
        }
      }
      const patternProperties = schema["patternProperties"];
      if (isJsonObject(patternProperties)) {
        for (const pattern of Object.keys(patternProperties)) {
          let re: RegExp;
          try {
            re = new RegExp(pattern);
          } catch {
            continue;
          }
          const subSchema = patternProperties[pattern] as Json;
          for (const key of Object.keys(instance)) {
            if (re.test(key)) {
              this.validateNode(
                subSchema,
                instance[key] as Json,
                appendPointer(pointer, key),
                depth + 1,
                violations,
                seen
              );
              evaluatedProperties.add(key);
            }
          }
        }
      }
      const additionalProperties = schema["additionalProperties"];
      if (additionalProperties !== undefined) {
        for (const key of Object.keys(instance)) {
          if (!evaluatedProperties.has(key)) {
            if (additionalProperties === false) {
              push(
                "additionalProperties",
                `Property ${JSON.stringify(key)} is not allowed.`,
                "additionalProperties"
              );
            } else {
              this.validateNode(
                additionalProperties,
                instance[key] as Json,
                appendPointer(pointer, key),
                depth + 1,
                violations,
                seen
              );
              evaluatedProperties.add(key);
            }
          }
        }
      }
      const required = schema["required"];
      if (Array.isArray(required)) {
        for (const key of required) {
          if (typeof key === "string" && !Object.hasOwn(instance, key)) {
            push(
              "required",
              `Required property ${JSON.stringify(key)} is missing.`,
              "required"
            );
          }
        }
      }
      const dependentRequired = schema["dependentRequired"];
      if (isJsonObject(dependentRequired)) {
        for (const key of Object.keys(dependentRequired)) {
          if (Object.hasOwn(instance, key)) {
            const deps = dependentRequired[key];
            if (Array.isArray(deps)) {
              for (const dep of deps) {
                if (typeof dep === "string" && !Object.hasOwn(instance, dep)) {
                  push(
                    "dependentRequired",
                    `Property ${JSON.stringify(dep)} is required when ${JSON.stringify(key)} is present.`,
                    "dependentRequired"
                  );
                }
              }
            }
          }
        }
      }
      const minProperties = schema["minProperties"];
      if (
        typeof minProperties === "number" &&
        Object.keys(instance).length < minProperties
      ) {
        push(
          "minProperties",
          `Object must have >= ${minProperties} properties.`,
          "minProperties"
        );
      }
      const maxProperties = schema["maxProperties"];
      if (
        typeof maxProperties === "number" &&
        Object.keys(instance).length > maxProperties
      ) {
        push(
          "maxProperties",
          `Object must have <= ${maxProperties} properties.`,
          "maxProperties"
        );
      }
      const propertyNames = schema["propertyNames"];
      if (propertyNames !== undefined) {
        for (const key of Object.keys(instance)) {
          const keyViolations = this.validate(propertyNames, key);
          for (const v of keyViolations) {
            violations.push({
              pointer: appendPointer(pointer, key),
              code: v.code === "type" ? "propertyNames_type" : v.code,
              message: `Property name is invalid: ${v.message}`,
              schema_path: "/propertyNames"
            });
          }
        }
      }
      const unevaluatedProperties = schema["unevaluatedProperties"];
      if (
        unevaluatedProperties !== undefined &&
        unevaluatedProperties !== false
      ) {
        for (const key of Object.keys(instance)) {
          if (!evaluatedProperties.has(key)) {
            this.validateNode(
              unevaluatedProperties,
              instance[key] as Json,
              appendPointer(pointer, key),
              depth + 1,
              violations,
              seen
            );
          }
        }
      }
    }

    // combinators
    const allOf = schema["allOf"];
    if (Array.isArray(allOf)) {
      for (const sub of allOf) {
        this.validateNode(sub, instance, pointer, depth + 1, violations, seen);
      }
    }
    const anyOf = schema["anyOf"];
    if (Array.isArray(anyOf)) {
      const anyOk = anyOf.some((sub) => this.isValid(sub, instance));
      if (!anyOk) {
        push("anyOf", "Value does not match any allowed schema.", "anyOf");
      }
    }
    const oneOf = schema["oneOf"];
    if (Array.isArray(oneOf)) {
      const matchCount = oneOf.filter((sub) =>
        this.isValid(sub, instance)
      ).length;
      if (matchCount !== 1) {
        push(
          "oneOf",
          `Value must match exactly one schema; matched ${matchCount}.`,
          "oneOf"
        );
      }
    }
    const not = schema["not"];
    if (not !== undefined) {
      if (this.isValid(not, instance)) {
        push("not", "Value must not match the excluded schema.", "not");
      }
    }
    const ifSchema = schema["if"];
    if (ifSchema !== undefined) {
      const conditionHolds = this.isValid(ifSchema, instance);
      const branch = conditionHolds ? schema["then"] : schema["else"];
      if (branch !== undefined) {
        this.validateNode(
          branch,
          instance,
          pointer,
          depth + 1,
          violations,
          seen
        );
      }
    }
  }
}

function jsonScalarEquals(a: Json, b: Json): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a === b;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a === b;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return a === b;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => jsonScalarEquals(item, b[i] as Json));
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    return aKeys.every(
      (key, i) =>
        key === bKeys[i] && jsonScalarEquals(a[key] as Json, b[key] as Json)
    );
  }
  return false;
}

/** The checked-in list of formats that packs may promote to assertions. */
export const ASSERTABLE_FORMATS: readonly string[] = [
  "date",
  "date-time",
  "time",
  "duration",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "uuid",
  "byte",
  "int32",
  "int64",
  "float",
  "double"
];
