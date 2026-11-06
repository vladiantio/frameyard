import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOperationAllowed,
  assertOverwriteAllowed,
  assertPolicyTier,
  assertProfileLimit,
  assertStillFrameLimit,
  describePolicy,
  findPolicyFile,
  loadResourcePolicy,
  resolveProfile,
  shouldLowerPriority,
  type LoadedResourcePolicy,
} from "../src/policy.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "frameyard-policy-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writePolicy(directory: string, value: unknown): Promise<void> {
  await writeFile(path.join(directory, "fy.policy.json"), JSON.stringify(value, null, 2));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function policy(overrides: Partial<LoadedResourcePolicy> = {}): LoadedResourcePolicy {
  return {
    tier: "authoring",
    maxStillFrames: 4,
    allowOverwrite: false,
    source: "env",
    ...overrides,
  };
}

describe("resource policy discovery", () => {
  it("finds the nearest policy file from a nested directory", async () => {
    const directory = await temporaryDirectory();
    const nested = path.join(directory, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writePolicy(directory, { version: 1, policy: "authoring" });

    expect(await findPolicyFile(nested)).toBe(path.join(directory, "fy.policy.json"));
  });

  it("defaults to full when no file or env override exists", async () => {
    const directory = await temporaryDirectory();
    const loaded = await loadResourcePolicy({ cwd: directory, env: {} });

    expect(loaded).toMatchObject({
      tier: "full",
      maxStillFrames: 32,
      allowOverwrite: true,
      source: "default",
    });
  });

  it("loads a strict policy file and applies tighten-only limits", async () => {
    const directory = await temporaryDirectory();
    await writePolicy(directory, {
      version: 1,
      policy: "authoring",
      profile: "shared-cpu",
      maxStillFrames: 2,
      allowOverwrite: false,
    });

    const loaded = await loadResourcePolicy({ cwd: directory, env: {} });
    expect(loaded).toMatchObject({
      tier: "authoring",
      profile: "shared-cpu",
      maxStillFrames: 2,
      allowOverwrite: false,
      source: "file",
    });
    expect(loaded.path).toBe(path.join(directory, "fy.policy.json"));
  });

  it("lets FRAMEYARD_POLICY replace the file and its limits", async () => {
    const directory = await temporaryDirectory();
    await writePolicy(directory, {
      version: 1,
      policy: "authoring",
      profile: "shared-cpu",
      maxStillFrames: 1,
    });

    const loaded = await loadResourcePolicy({ cwd: directory, env: { FRAMEYARD_POLICY: "full" } });
    expect(loaded).toMatchObject({
      tier: "full",
      maxStillFrames: 32,
      allowOverwrite: true,
      source: "env",
    });
    expect(loaded.profile).toBeUndefined();
  });

  it("rejects unknown fields, versions, and loosened limits", async () => {
    const directory = await temporaryDirectory();

    await writePolicy(directory, { version: 1, policy: "authoring", extra: true });
    await expect(loadResourcePolicy({ cwd: directory, env: {} })).rejects.toMatchObject({
      code: "POLICY_INVALID",
    });

    await writePolicy(directory, { version: 2, policy: "authoring" });
    await expect(loadResourcePolicy({ cwd: directory, env: {} })).rejects.toMatchObject({
      code: "POLICY_INVALID",
    });

    await writePolicy(directory, { version: 1, policy: "authoring", maxStillFrames: 5 });
    await expect(loadResourcePolicy({ cwd: directory, env: {} })).rejects.toMatchObject({
      code: "POLICY_INVALID",
    });

    await writePolicy(directory, { version: 1, policy: "authoring", allowOverwrite: true });
    await expect(loadResourcePolicy({ cwd: directory, env: {} })).rejects.toMatchObject({
      code: "POLICY_INVALID",
    });
  });

  it("rejects an invalid environment override", async () => {
    const directory = await temporaryDirectory();
    await expect(loadResourcePolicy({ cwd: directory, env: { FRAMEYARD_POLICY: "turbo" } })).rejects.toMatchObject({
      code: "POLICY_INVALID",
      details: { source: "env", allowed: ["light", "authoring", "full"] },
    });
  });
});

describe("resource policy gates", () => {
  it("blocks check in light and heavy operations outside full", () => {
    expect(() => assertOperationAllowed(policy({ tier: "light" }), "check")).toThrow(
      expect.objectContaining({ code: "RESOURCE_POLICY_BLOCKED" }),
    );
    expect(() => assertOperationAllowed(policy({ tier: "authoring" }), "render")).toThrow(
      expect.objectContaining({ code: "RESOURCE_POLICY_BLOCKED" }),
    );
    expect(() => assertOperationAllowed(policy({ tier: "authoring" }), "tts")).toThrow(
      expect.objectContaining({ code: "RESOURCE_POLICY_BLOCKED" }),
    );
    expect(() => assertOperationAllowed(policy({ tier: "full" }), "render")).not.toThrow();
    expect(() => assertOperationAllowed(policy({ tier: "light" }), "font")).not.toThrow();
  });

  it("requires a higher tier for font writes and removal", () => {
    expect(() => assertPolicyTier(policy({ tier: "light" }), "authoring", "font add")).toThrow(
      expect.objectContaining({ code: "RESOURCE_POLICY_BLOCKED" }),
    );
    expect(() => assertPolicyTier(policy({ tier: "authoring" }), "authoring", "font add")).not.toThrow();
    expect(() => assertPolicyTier(policy({ tier: "authoring" }), "full", "font remove")).toThrow(
      expect.objectContaining({ code: "RESOURCE_POLICY_BLOCKED" }),
    );
    expect(() => assertPolicyTier(policy({ tier: "full", allowOverwrite: true }), "full", "font remove")).not.toThrow();
  });

  it("lets every tier run a dry run", () => {
    expect(() => assertOperationAllowed(policy({ tier: "light" }), "render", { dryRun: true })).not.toThrow();
  });

  it("enforces the still caps and overwrite permission", () => {
    expect(() => assertStillFrameLimit(policy(), 4)).not.toThrow();
    expect(() => assertStillFrameLimit(policy(), 5)).toThrow(
      expect.objectContaining({ code: "RESOURCE_POLICY_LIMIT" }),
    );
    expect(() => assertOverwriteAllowed(policy(), "overwrite")).toThrow(
      expect.objectContaining({ code: "RESOURCE_POLICY_BLOCKED" }),
    );
    expect(() => assertOverwriteAllowed(policy({ tier: "full", allowOverwrite: true }), "force")).not.toThrow();
  });

  it("rejects values above a profile cap instead of clamping", () => {
    expect(() => assertProfileLimit("shared-cpu", "workers", 3, 2)).toThrow(
      expect.objectContaining({ code: "RESOURCE_PROFILE_CONFLICT" }),
    );
    expect(() => assertProfileLimit("shared-cpu", "workers", 2, 2)).not.toThrow();
  });

  it("resolves profiles and priority", () => {
    expect(resolveProfile(policy(), "shared-cpu")).toBe("shared-cpu");
    expect(() => resolveProfile(policy(), "turbo")).toThrow(expect.objectContaining({ code: "USAGE" }));
    expect(shouldLowerPriority(policy({ tier: "authoring" }), undefined, false)).toBe(true);
    expect(shouldLowerPriority(policy({ tier: "full" }), undefined, false)).toBe(false);
    expect(shouldLowerPriority(policy({ tier: "full" }), "shared-cpu", false)).toBe(true);
    expect(shouldLowerPriority(policy({ tier: "full" }), undefined, true)).toBe(true);
  });

  it("describes the active policy for humans", () => {
    expect(describePolicy(policy({ profile: "shared-cpu" }))).toBe(
      "authoring, shared-cpu, still ≤4, overwrite blocked",
    );
  });
});
