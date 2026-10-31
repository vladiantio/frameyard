import { describe, expect, it } from "vitest";
import { scaffoldFiles } from "../src/scaffold.ts";
import { VERSION } from "../src/version.ts";

function manifest(projectName: string): Record<string, unknown> {
  return JSON.parse(scaffoldFiles(projectName)["package.json"] ?? "") as Record<string, unknown>;
}

describe("scaffold files", () => {
  it("generates a pinned private package manifest", () => {
    expect(manifest("my-video")).toEqual({
      name: "my-video",
      private: true,
      type: "module",
      scripts: {
        dev: `npx --yes frameyard@${VERSION} dev`,
        check: `npx --yes frameyard@${VERSION} check`,
        render: `npx --yes frameyard@${VERSION} render`,
        still: `npx --yes frameyard@${VERSION} still`,
      },
    });
  });

  it("normalizes project names into valid npm package names", () => {
    expect(manifest("My Video").name).toBe("my-video");
    expect(manifest("Hello_World!").name).toBe("hello_world");
    expect(manifest("---").name).toBe("frameyard-project");
    expect(manifest("").name).toBe("frameyard-project");
  });

  it("ignores render output in generated projects", () => {
    expect(scaffoldFiles("my-video")[".gitignore"]).toBe("out/\n");
  });
});
