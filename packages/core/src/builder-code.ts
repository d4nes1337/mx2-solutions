/**
 * Polymarket builder-code helpers. The builder code is a PUBLIC bytes32
 * identifier (not a secret) that the SDK serializes into the signed order's
 * `builder` field; matched volume carrying it is credited to the builder
 * (D-006, INTEGRATION §7/§12a). Attribution is release-critical, so every
 * money-moving path validates the code with these shared predicates rather than
 * re-implementing the check.
 */
export const BUILDER_CODE_RE = /^0x[0-9a-fA-F]{64}$/;

/** The all-zero bytes32 — a structurally valid but UNATTRIBUTED builder field. */
export const ZERO_BUILDER_CODE = `0x${"0".repeat(64)}`;

/** True when the value is a 0x-prefixed 32-byte hex string. */
export const isValidBuilderCode = (code: string | null | undefined): code is string =>
  typeof code === "string" && BUILDER_CODE_RE.test(code);

/** True when the value is a valid bytes32 AND not the all-zero (unattributed) code. */
export const isNonZeroBuilderCode = (code: string | null | undefined): code is string =>
  isValidBuilderCode(code) && code.toLowerCase() !== ZERO_BUILDER_CODE;

/**
 * Case-insensitive equality for two builder-code hex strings. Returns false if
 * either side is missing or malformed — so a comparison never silently passes
 * on a bad value.
 */
export const builderCodesEqual = (a: string | null | undefined, b: string | null | undefined) =>
  isValidBuilderCode(a) && isValidBuilderCode(b) && a.toLowerCase() === b.toLowerCase();
