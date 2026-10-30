import { describe, expect, it } from "vitest";
import { readCompositionDescriptor, type DocumentAdapter, type SourceLocation } from "../src/composition/index.ts";

interface FakeDocument {
  kind: "document";
  children: FakeNode[];
}

interface FakeElement {
  kind: "element";
  tag: string;
  attributes?: Record<string, string>;
  children?: FakeNode[];
  content?: FakeNode[];
  location?: SourceLocation;
  attributeLocations?: Record<string, SourceLocation>;
}

interface FakeText {
  kind: "text";
  text: string;
  location?: SourceLocation;
}

type FakeNode = FakeDocument | FakeElement | FakeText;

const defaultMetadata = {
  width: "320",
  height: "180",
  fps: "10",
  "duration-in-frames": "5",
};

function location(line: number, column = 1): SourceLocation {
  return { startLine: line, startCol: column, endLine: line, endCol: column + 1 };
}

function element(
  tag: string,
  options: {
    attributes?: Record<string, string>;
    children?: FakeNode[];
    content?: FakeNode[];
    location?: SourceLocation;
    attributeLocations?: Record<string, SourceLocation>;
  } = {},
): FakeElement {
  return {
    kind: "element",
    tag,
    ...(options.attributes !== undefined ? { attributes: options.attributes } : {}),
    ...(options.children !== undefined ? { children: options.children } : {}),
    ...(options.content !== undefined ? { content: options.content } : {}),
    ...(options.location !== undefined ? { location: options.location } : {}),
    ...(options.attributeLocations !== undefined ? { attributeLocations: options.attributeLocations } : {}),
  };
}

function text(value: string, at?: SourceLocation): FakeText {
  return { kind: "text", text: value, ...(at !== undefined ? { location: at } : {}) };
}

function textContent(node: FakeNode): string {
  if (node.kind === "text") {
    return node.text;
  }
  return node.children?.map(textContent).join("") ?? "";
}

function adapterFor(root: FakeDocument): DocumentAdapter<FakeNode> {
  return {
    root,
    isElement: (node) => node.kind === "element",
    tagName: (node) => (node.kind === "element" ? node.tag : ""),
    attributes: (node) =>
      node.kind === "element" ? Object.entries(node.attributes ?? {}).map(([name, value]) => ({ name, value })) : [],
    children: (node) =>
      node.kind === "document" ? node.children : node.kind === "element" ? (node.children ?? []) : [],
    templateContent: (node) => (node.kind === "element" && node.tag === "template" ? (node.content ?? []) : undefined),
    text: (node) => textContent(node),
    location: (node, attribute) => {
      if (node.kind === "element") {
        return attribute !== undefined ? (node.attributeLocations?.[attribute] ?? node.location) : node.location;
      }
      return node.kind === "text" ? node.location : undefined;
    },
  };
}

function makeDocument(
  options: {
    root?: FakeElement;
    includeRoot?: boolean;
    rootInTemplate?: boolean;
    head?: FakeNode[];
    body?: FakeNode[];
  } = {},
): FakeDocument {
  const root =
    options.root ??
    element("fy-composition", {
      attributes: defaultMetadata,
      location: location(5, 3),
    });
  const rootContainer = options.rootInTemplate ? element("template", { content: [root] }) : root;
  const bodyChildren = options.includeRoot === false ? (options.body ?? []) : [rootContainer, ...(options.body ?? [])];

  return {
    kind: "document",
    children: [
      element("html", {
        children: [element("head", { children: options.head ?? [] }), element("body", { children: bodyChildren })],
      }),
    ],
  };
}

function propsBlock(json: string, at?: SourceLocation): FakeElement {
  return element("script", {
    attributes: { type: "application/json", "data-fy": "props" },
    children: [text(json)],
    ...(at !== undefined ? { location: at } : {}),
  });
}

function controllerBlock(options: { src?: string; source?: string; location?: SourceLocation }): FakeElement {
  return element("script", {
    attributes: {
      type: "text/fy-controller",
      ...(options.src !== undefined ? { src: options.src } : {}),
    },
    children: options.source !== undefined ? [text(options.source)] : [],
    ...(options.location !== undefined ? { location: options.location } : {}),
    ...(options.src !== undefined && options.location !== undefined
      ? { attributeLocations: { src: options.location } }
      : {}),
  });
}

const resolvePath = (raw: string): string => `compositions/${raw.replace(/^\.\//, "")}`;
const options = { path: "compositions/hello.html", resolvePath };

describe("composition document reader", () => {
  it("reads metadata, default props, and an external controller", () => {
    const root = element("fy-composition", {
      attributes: defaultMetadata,
      location: location(5, 3),
    });
    const document = makeDocument({
      root,
      head: [propsBlock('{"title":"Hello"}', location(8, 5))],
      body: [controllerBlock({ src: "./hello.controller.js", location: location(12, 5) })],
    });
    const result = readCompositionDescriptor(adapterFor(document), options);

    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.root).toBe(root);
    expect(result.descriptor.metadata).toEqual({ width: 320, height: 180, fps: 10, durationInFrames: 5 });
    expect(result.descriptor.defaultProps).toEqual({ title: "Hello" });
    expect(Object.isFrozen(result.descriptor.defaultProps)).toBe(true);
    expect(result.descriptor.controller).toMatchObject({
      kind: "external",
      src: "compositions/hello.controller.js",
      rawSrc: "./hello.controller.js",
      line: 12,
      column: 5,
    });
  });

  it("reads an inline controller from its text location", () => {
    const source = "export default { mount() {} };";
    const document = makeDocument({
      body: [
        element("script", {
          attributes: { type: "text/fy-controller" },
          children: [text(source, location(14, 1))],
          location: location(13, 3),
        }),
      ],
    });
    const result = readCompositionDescriptor(adapterFor(document), options);

    expect(result.valid).toBe(true);
    expect(result.descriptor.controller).toMatchObject({
      kind: "inline",
      source,
      line: 14,
      column: 1,
    });
  });

  it("reports a missing root and still reports invalid props", () => {
    const document = makeDocument({
      includeRoot: false,
      head: [propsBlock("{")],
    });
    const result = readCompositionDescriptor(adapterFor(document), options);

    expect(result.root).toBeNull();
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "COMPOSITION_INVALID",
        message: expect.stringContaining("one <fy-composition> root"),
        details: expect.objectContaining({ path: "compositions/hello.html" }),
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PROPS_INVALID",
        message: expect.stringContaining("Invalid default props"),
      }),
    );
  });

  it("reports multiple roots, an outside-body root, and a template root", () => {
    const first = element("fy-composition", { attributes: defaultMetadata, location: location(5, 3) });
    const second = element("fy-composition", { attributes: defaultMetadata, location: location(6, 3) });
    const multiple = readCompositionDescriptor(adapterFor(makeDocument({ root: first, body: [second] })), options);

    expect(multiple.root).toBe(first);
    expect(multiple.valid).toBe(false);
    expect(multiple.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "COMPOSITION_INVALID",
        message: expect.stringContaining("exactly one"),
        details: expect.objectContaining({ element: "fy-composition", line: 6 }),
      }),
    );

    const outside = readCompositionDescriptor(
      adapterFor({
        kind: "document",
        children: [element("html", { children: [element("head", { children: [first] })] })],
      }),
      options,
    );
    expect(outside.valid).toBe(false);
    expect(outside.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "COMPOSITION_INVALID",
        message: expect.stringContaining("inside <body>"),
      }),
    );

    const inTemplate = readCompositionDescriptor(
      adapterFor(makeDocument({ root: first, rootInTemplate: true })),
      options,
    );
    expect(inTemplate.valid).toBe(false);
    expect(inTemplate.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "COMPOSITION_INVALID",
        message: expect.stringContaining("inside a <template>"),
      }),
    );
  });

  it("reports metadata errors with attribute locations", () => {
    const root = element("fy-composition", {
      attributes: { ...defaultMetadata, width: "0" },
      location: location(5, 3),
      attributeLocations: { width: location(5, 18) },
    });
    const result = readCompositionDescriptor(adapterFor(makeDocument({ root })), options);

    expect(result.valid).toBe(false);
    expect(result.descriptor.metadata).toBeNull();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "COMPOSITION_INVALID",
        message: expect.stringContaining("positive integer"),
        details: expect.objectContaining({
          path: "compositions/hello.html",
          element: "fy-composition",
          attribute: "width",
          value: "0",
          line: 5,
          column: 18,
        }),
      }),
    );
  });

  it("reports duplicate, invalid, and template-scoped props blocks", () => {
    const duplicate = readCompositionDescriptor(
      adapterFor(
        makeDocument({
          head: [propsBlock('{"title":"A"}'), propsBlock('{"title":"B"}', location(9, 5))],
        }),
      ),
      options,
    );
    expect(duplicate.valid).toBe(false);
    expect(duplicate.descriptor.defaultProps).toEqual({ title: "A" });
    expect(duplicate.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PROPS_INVALID",
        message: expect.stringContaining("at most one"),
        details: expect.objectContaining({ element: "script", line: 9 }),
      }),
    );

    const invalid = readCompositionDescriptor(
      adapterFor(makeDocument({ head: [propsBlock('{"title": "A", "count": }')] })),
      options,
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.descriptor.defaultProps).toEqual({});
    expect(invalid.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PROPS_INVALID",
        message: expect.stringContaining("Invalid default props"),
      }),
    );

    const inTemplate = readCompositionDescriptor(
      adapterFor(
        makeDocument({
          body: [element("template", { content: [propsBlock('{"title":"A"}')] })],
        }),
      ),
      options,
    );
    expect(inTemplate.valid).toBe(false);
    expect(inTemplate.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PROPS_INVALID",
        message: expect.stringContaining("inside a <template>"),
      }),
    );
  });

  it("reports controller declaration errors", () => {
    const both = readCompositionDescriptor(
      adapterFor(
        makeDocument({
          body: [
            element("script", {
              attributes: { type: "text/fy-controller", src: "./hello.controller.js" },
              children: [text("export default {};")],
            }),
          ],
        }),
      ),
      options,
    );
    expect(both.valid).toBe(false);
    expect(both.descriptor.controller).toBeNull();
    expect(both.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONTROLLER_INVALID",
        message: expect.stringContaining("either inline or external"),
        details: expect.objectContaining({ attribute: "src" }),
      }),
    );

    const neither = readCompositionDescriptor(
      adapterFor(makeDocument({ body: [element("script", { attributes: { type: "text/fy-controller" } })] })),
      options,
    );
    expect(neither.valid).toBe(false);
    expect(neither.descriptor.controller).toBeNull();
    expect(neither.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONTROLLER_INVALID",
        message: expect.stringContaining("inline source"),
      }),
    );

    const remote = readCompositionDescriptor(
      adapterFor(
        makeDocument({
          body: [controllerBlock({ src: "https://example.com/controller.js" })],
        }),
      ),
      options,
    );
    expect(remote.valid).toBe(false);
    expect(remote.descriptor.controller).toMatchObject({
      kind: "external",
      rawSrc: "https://example.com/controller.js",
    });
    expect(remote.descriptor.controller?.src).toBeUndefined();
    expect(remote.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONTROLLER_INVALID",
        message: expect.stringContaining("local project file"),
        details: expect.objectContaining({ value: "https://example.com/controller.js" }),
      }),
    );
  });

  it("reports duplicate controllers and resolver failures", () => {
    const duplicate = readCompositionDescriptor(
      adapterFor(
        makeDocument({
          body: [
            controllerBlock({ src: "./hello.controller.js" }),
            controllerBlock({ src: "./other.controller.js", location: location(18, 5) }),
          ],
        }),
      ),
      options,
    );
    expect(duplicate.valid).toBe(false);
    expect(duplicate.descriptor.controller).toMatchObject({
      kind: "external",
      src: "compositions/hello.controller.js",
    });
    expect(duplicate.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONTROLLER_INVALID",
        message: expect.stringContaining("at most one"),
        details: expect.objectContaining({ line: 18 }),
      }),
    );

    const failing = readCompositionDescriptor(
      adapterFor(makeDocument({ body: [controllerBlock({ src: "./hello.controller.js" })] })),
      {
        path: "compositions/hello.html",
        resolvePath: () => {
          throw new Error("no path");
        },
      },
    );
    expect(failing.valid).toBe(false);
    expect(failing.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "CONTROLLER_INVALID",
        message: expect.stringContaining("Could not resolve"),
      }),
    );
  });
});
