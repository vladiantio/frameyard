import { describe, expect, it } from "vitest";
import {
  coerceAttribute,
  coerceClass,
  coerceText,
  isTruthy,
  resolveBindingPath,
  suggestBindingPath,
  validateBindingPath,
} from "../src/bindings.ts";
import type { Props } from "../src/contracts.ts";

const props: Props = {
  title: "Hello",
  user: { name: "Ada" },
  items: [{ label: "A" }, { label: "B" }],
  show: true,
  count: 0,
  empty: "",
};

describe("binding paths", () => {
  it("resolves props, nested props, and numeric array segments", () => {
    expect(resolveBindingPath({ props }, "title")).toEqual({ found: true, value: "Hello" });
    expect(resolveBindingPath({ props }, "user.name")).toEqual({ found: true, value: "Ada" });
    expect(resolveBindingPath({ props }, "items.1.label")).toEqual({ found: true, value: "B" });
    expect(resolveBindingPath({ props }, "items.length")).toEqual({ found: true, value: 2 });
  });

  it("returns not found for missing paths and prototype keys", () => {
    expect(resolveBindingPath({ props }, "missing")).toEqual({ found: false, value: undefined });
    expect(resolveBindingPath({ props }, "__proto__.polluted")).toEqual({ found: false, value: undefined });
    expect(resolveBindingPath({ props }, "constructor")).toEqual({ found: false, value: undefined });
  });

  it("resolves item and index inside a repeat scope", () => {
    const scope = { props, repeat: { item: { label: "X" }, index: 3 } };

    expect(resolveBindingPath(scope, "item.label")).toEqual({ found: true, value: "X" });
    expect(resolveBindingPath(scope, "index")).toEqual({ found: true, value: 3 });
    expect(resolveBindingPath({ props }, "item.label")).toEqual({ found: false, value: undefined });
  });

  it("validates path syntax", () => {
    expect(validateBindingPath("title").ok).toBe(true);
    expect(validateBindingPath("user.name").ok).toBe(true);
    expect(validateBindingPath("items.0.label").ok).toBe(true);
    expect(validateBindingPath("a-b").ok).toBe(true);
    expect(validateBindingPath("").ok).toBe(false);
    expect(validateBindingPath("a..b").ok).toBe(false);
    expect(validateBindingPath("__proto__").ok).toBe(false);
    expect(validateBindingPath("a b").ok).toBe(false);
  });

  it("suggests the closest top-level prop", () => {
    expect(suggestBindingPath("titel", props)).toBe("title");
    expect(suggestBindingPath("usr.name", props)).toBe("user");
    expect(suggestBindingPath("completely-unknown", props)).toBeUndefined();
    expect(suggestBindingPath("title", props)).toBeUndefined();
  });
});

describe("binding value coercion", () => {
  it("coerces text values", () => {
    expect(coerceText("hello")).toEqual({ value: "hello" });
    expect(coerceText(0)).toEqual({ value: "0" });
    expect(coerceText(false)).toEqual({ value: "false" });
    expect(coerceText(null)).toEqual({ value: "" });
    expect(coerceText(undefined)).toEqual({ value: "" });
    expect(coerceText({})).toEqual({ value: "", invalid: true });
    expect(coerceText([])).toEqual({ value: "", invalid: true });
  });

  it("coerces attribute values", () => {
    expect(coerceAttribute(true)).toEqual({ value: "" });
    expect(coerceAttribute(false)).toEqual({ value: null });
    expect(coerceAttribute(null)).toEqual({ value: null });
    expect(coerceAttribute(0)).toEqual({ value: "0" });
    expect(coerceAttribute("x")).toEqual({ value: "x" });
    expect(coerceAttribute({})).toEqual({ value: null, invalid: true });
  });

  it("coerces class values with JavaScript truthiness", () => {
    expect(coerceClass(true)).toEqual({ value: true });
    expect(coerceClass(false)).toEqual({ value: false });
    expect(coerceClass("active")).toEqual({ value: true });
    expect(coerceClass("")).toEqual({ value: false });
    expect(coerceClass(0)).toEqual({ value: false });
    expect(coerceClass({})).toEqual({ value: false, invalid: true });
    expect(isTruthy([])).toBe(true);
  });
});
