import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPlainObject } from "./contracts.js";
import { FrameyardError } from "./errors.js";

/** Project-local resource policy file discovered from the working directory upward. */
export const POLICY_FILE_NAME = "frameyard.policy.json";

export const POLICY_TIERS = ["light", "authoring", "full"] as const;
export type PolicyTier = (typeof POLICY_TIERS)[number];

export const RESOURCE_PROFILES = ["shared-cpu"] as const;
export type ResourceProfile = (typeof RESOURCE_PROFILES)[number];

export const MAX_STILL_FRAMES = 32;
export const SHARED_CPU_MAX_WORKERS = 2;
export const SHARED_CPU_MAX_CONCURRENCY = 1;

const POLICY_VERSION = 1;
const POLICY_FIELDS = new Set(["version", "policy", "profile", "maxStillFrames", "allowOverwrite"]);

export const TIER_DEFAULTS: Record<
  PolicyTier,
  {
    maxStillFrames: number;
    allowOverwrite: boolean;
  }
> = {
  light: { maxStillFrames: 1, allowOverwrite: false },
  authoring: { maxStillFrames: 4, allowOverwrite: false },
  full: { maxStillFrames: MAX_STILL_FRAMES, allowOverwrite: true },
};

export type PolicyOperation =
  | "lint"
  | "context"
  | "doctor"
  | "init"
  | "dev"
  | "check"
  | "still"
  | "tts"
  | "transcribe"
  | "render";

export interface LoadedResourcePolicy {
  tier: PolicyTier;
  profile?: ResourceProfile;
  maxStillFrames: number;
  allowOverwrite: boolean;
  source: "default" | "file" | "env";
  /** Absolute path of the policy file when `source` is `"file"`. */
  path?: string;
}

export interface PolicyDescription {
  policy: PolicyTier;
  profile?: ResourceProfile;
  maxStillFrames: number;
  allowOverwrite: boolean;
  source: LoadedResourcePolicy["source"];
  path?: string;
}

function isPolicyTier(value: unknown): value is PolicyTier {
  return typeof value === "string" && (POLICY_TIERS as readonly string[]).includes(value);
}

function isResourceProfile(value: unknown): value is ResourceProfile {
  return typeof value === "string" && (RESOURCE_PROFILES as readonly string[]).includes(value);
}

function policyError(message: string, details: Record<string, unknown>): never {
  throw new FrameyardError("POLICY_INVALID", message, { details });
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/** Walks up from a directory until it finds frameyard.policy.json. */
export async function findPolicyFile(start = process.cwd()): Promise<string | undefined> {
  let current = path.resolve(start);

  try {
    if (!(await stat(current)).isDirectory()) {
      current = path.dirname(current);
    }
  } catch {
    return undefined;
  }

  while (true) {
    const candidate = path.join(current, POLICY_FILE_NAME);
    if (await isFile(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function validatePolicyFile(value: unknown, filePath: string): Omit<LoadedResourcePolicy, "source" | "path"> {
  if (!isPlainObject(value)) {
    policyError(`${POLICY_FILE_NAME} must contain a JSON object.`, {
      path: filePath,
      suggestion: `Write a policy file such as { "version": 1, "policy": "authoring" }.`,
    });
  }

  for (const key of Object.keys(value)) {
    if (!POLICY_FIELDS.has(key)) {
      policyError(`${POLICY_FILE_NAME} contains an unknown field "${key}".`, {
        path: filePath,
        jsonPath: `$.${key}`,
        allowed: [...POLICY_FIELDS],
        suggestion: "Remove the field or use one of the documented policy fields.",
      });
    }
  }

  if (value.version !== POLICY_VERSION) {
    policyError(`${POLICY_FILE_NAME} must declare "version": ${POLICY_VERSION}.`, {
      path: filePath,
      jsonPath: "$.version",
      value: value.version,
      allowed: [POLICY_VERSION],
    });
  }

  if (!isPolicyTier(value.policy)) {
    policyError(`${POLICY_FILE_NAME} must declare policy as "light", "authoring", or "full".`, {
      path: filePath,
      jsonPath: "$.policy",
      value: value.policy,
      allowed: [...POLICY_TIERS],
    });
  }

  const tier = value.policy;
  const defaults = TIER_DEFAULTS[tier];

  if (value.profile !== undefined && !isResourceProfile(value.profile)) {
    policyError(`${POLICY_FILE_NAME} profile must be "shared-cpu".`, {
      path: filePath,
      jsonPath: "$.profile",
      value: value.profile,
      allowed: [...RESOURCE_PROFILES],
    });
  }

  let maxStillFrames = defaults.maxStillFrames;
  if (value.maxStillFrames !== undefined) {
    if (
      !Number.isInteger(value.maxStillFrames) ||
      (value.maxStillFrames as number) < 1 ||
      (value.maxStillFrames as number) > MAX_STILL_FRAMES
    ) {
      policyError(`${POLICY_FILE_NAME} maxStillFrames must be an integer from 1 to ${MAX_STILL_FRAMES}.`, {
        path: filePath,
        jsonPath: "$.maxStillFrames",
        value: value.maxStillFrames,
        allowed: { min: 1, max: MAX_STILL_FRAMES },
      });
    }
    if ((value.maxStillFrames as number) > defaults.maxStillFrames) {
      policyError(
        `${POLICY_FILE_NAME} maxStillFrames cannot exceed the ${tier} default of ${defaults.maxStillFrames}.`,
        {
          path: filePath,
          jsonPath: "$.maxStillFrames",
          value: value.maxStillFrames,
          limit: defaults.maxStillFrames,
          suggestion: "A policy file can only tighten the tier limits.",
        },
      );
    }
    maxStillFrames = value.maxStillFrames as number;
  }

  let allowOverwrite = defaults.allowOverwrite;
  if (value.allowOverwrite !== undefined) {
    if (typeof value.allowOverwrite !== "boolean") {
      policyError(`${POLICY_FILE_NAME} allowOverwrite must be a boolean.`, {
        path: filePath,
        jsonPath: "$.allowOverwrite",
        value: value.allowOverwrite,
      });
    }
    if (value.allowOverwrite === true && !defaults.allowOverwrite) {
      policyError(`${POLICY_FILE_NAME} allowOverwrite cannot be true in the ${tier} tier.`, {
        path: filePath,
        jsonPath: "$.allowOverwrite",
        value: value.allowOverwrite,
        suggestion: "A policy file can only tighten the tier limits; use FRAMEYARD_POLICY=full to allow overwrites.",
      });
    }
    allowOverwrite = value.allowOverwrite;
  }

  return {
    tier,
    ...(value.profile !== undefined ? { profile: value.profile as ResourceProfile } : {}),
    maxStillFrames,
    allowOverwrite,
  };
}

async function loadPolicyFile(filePath: string): Promise<LoadedResourcePolicy> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new FrameyardError("POLICY_INVALID", `Could not read ${filePath}.`, {
      cause: error,
      details: { path: filePath },
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    policyError(`${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      path: filePath,
    });
  }

  return {
    ...validatePolicyFile(value, filePath),
    source: "file",
    path: filePath,
  };
}

/**
 * Loads the resource policy for the current workspace.
 *
 * `FRAMEYARD_POLICY` replaces the policy file entirely, so an explicit human
 * override also resets the file's profile and tightened limits. Without the
 * variable, the nearest `frameyard.policy.json` from `cwd` upward wins; without
 * a file, the default is `full`.
 */
export async function loadResourcePolicy(
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<LoadedResourcePolicy> {
  const env = options.env ?? process.env;
  const requested = env.FRAMEYARD_POLICY;
  if (requested !== undefined) {
    const value = requested.trim();
    if (!isPolicyTier(value)) {
      policyError(`FRAMEYARD_POLICY must be "light", "authoring", or "full"; received "${requested}".`, {
        source: "env",
        value: requested,
        allowed: [...POLICY_TIERS],
      });
    }
    const defaults = TIER_DEFAULTS[value];
    return {
      tier: value,
      ...defaults,
      source: "env",
    };
  }

  const filePath = await findPolicyFile(options.cwd ?? process.cwd());
  if (filePath === undefined) {
    const defaults = TIER_DEFAULTS.full;
    return {
      tier: "full",
      ...defaults,
      source: "default",
    };
  }

  return loadPolicyFile(filePath);
}

/** Resolves the effective profile from the CLI flag and the policy file. */
export function resolveProfile(
  policy: LoadedResourcePolicy,
  requested: string | undefined,
): ResourceProfile | undefined {
  if (requested === undefined) {
    return policy.profile;
  }
  if (!isResourceProfile(requested)) {
    throw new FrameyardError("USAGE", `--profile must be "shared-cpu"; received "${requested}".`);
  }
  return requested;
}

/** Returns the operation allowlist for a tier. */
export function allowedOperations(tier: PolicyTier): PolicyOperation[] {
  const operations: PolicyOperation[] = ["lint", "context", "doctor", "init", "dev", "still"];
  if (tier !== "light") {
    operations.push("check");
  }
  if (tier === "full") {
    operations.push("tts", "transcribe", "render");
  }
  return operations;
}

export function operationAllowed(tier: PolicyTier, operation: PolicyOperation): boolean {
  return allowedOperations(tier).includes(operation);
}

function operationSuggestion(operation: PolicyOperation, tier: PolicyTier): string {
  if (operation === "check") {
    return "Use lint and still in the light tier, or run check from authoring or full.";
  }
  if (operation === "render" || operation === "tts" || operation === "transcribe") {
    return `Run the command with --dry-run to produce a handoff plan, or set FRAMEYARD_POLICY=full when the user explicitly asks for the heavy operation.`;
  }
  return `The ${tier} policy does not allow ${operation}.`;
}

export function assertOperationAllowed(
  policy: LoadedResourcePolicy,
  operation: PolicyOperation,
  options: { dryRun?: boolean } = {},
): void {
  if (options.dryRun === true) {
    return;
  }
  if (operationAllowed(policy.tier, operation)) {
    return;
  }
  throw new FrameyardError(
    "RESOURCE_POLICY_BLOCKED",
    `"${operation}" is blocked by the ${policy.tier} resource policy.`,
    {
      details: {
        policy: policy.tier,
        operation,
        allowed: allowedOperations(policy.tier),
        suggestion: operationSuggestion(operation, policy.tier),
      },
    },
  );
}

export function assertStillFrameLimit(policy: LoadedResourcePolicy, requested: number): void {
  if (requested <= policy.maxStillFrames) {
    return;
  }
  throw new FrameyardError(
    "RESOURCE_POLICY_LIMIT",
    `Still requested ${requested} frames; the ${policy.tier} policy allows at most ${policy.maxStillFrames}.`,
    {
      details: {
        policy: policy.tier,
        limit: policy.maxStillFrames,
        requested,
        suggestion: `Capture at most ${policy.maxStillFrames} frames per invocation, or use FRAMEYARD_POLICY=full for a larger inspection batch.`,
      },
    },
  );
}

export function assertOverwriteAllowed(policy: LoadedResourcePolicy, operation: "overwrite" | "force"): void {
  if (policy.allowOverwrite) {
    return;
  }
  throw new FrameyardError(
    "RESOURCE_POLICY_BLOCKED",
    `--${operation} is blocked by the ${policy.tier} resource policy.`,
    {
      details: {
        policy: policy.tier,
        operation,
        allowed: false,
        suggestion:
          "Use a new output path, or ask the user to run the command with FRAMEYARD_POLICY=full when replacement is intended.",
      },
    },
  );
}

export function assertProfileLimit(
  profile: ResourceProfile,
  option: "workers" | "concurrency",
  requested: number,
  limit: number,
): void {
  if (requested <= limit) {
    return;
  }
  throw new FrameyardError(
    "RESOURCE_PROFILE_CONFLICT",
    `--${option} ${requested} exceeds the ${profile} profile limit of ${limit}.`,
    {
      details: {
        profile,
        option,
        requested,
        limit,
        suggestion: "Lower the value, or omit --profile when the machine is not shared with a local model.",
      },
    },
  );
}

export function shouldLowerPriority(
  policy: LoadedResourcePolicy,
  profile: ResourceProfile | undefined,
  requested: boolean,
): boolean {
  return requested || profile === "shared-cpu" || policy.tier === "authoring" || policy.tier === "light";
}

/**
 * Lowers the current process priority so it yields to a local model. Children
 * inherit the nice value on Unix. This is best effort on platforms that do not
 * expose process priorities.
 */
export function lowerProcessPriority(): void {
  try {
    const priority =
      process.platform === "win32" ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_LOW;
    os.setPriority(0, priority);
  } catch {
    // Priority changes are advisory; rendering still proceeds when unsupported.
  }
}

/** Serializable policy details for JSON results and diagnostics. */
export function policyDetails(policy: LoadedResourcePolicy): PolicyDescription {
  return {
    policy: policy.tier,
    ...(policy.profile !== undefined ? { profile: policy.profile } : {}),
    maxStillFrames: policy.maxStillFrames,
    allowOverwrite: policy.allowOverwrite,
    source: policy.source,
    ...(policy.path !== undefined ? { path: policy.path } : {}),
  };
}

export function describePolicy(policy: LoadedResourcePolicy): string {
  const parts: string[] = [policy.tier];
  if (policy.profile !== undefined) {
    parts.push(policy.profile);
  }
  parts.push(`still ≤${policy.maxStillFrames}`);
  parts.push(policy.allowOverwrite ? "overwrite allowed" : "overwrite blocked");
  return parts.join(", ");
}
