import { describe, expect, it } from "vitest";
import { isFormControl } from "./keys";

const el = (tagName: string, isContentEditable = false) =>
  ({ tagName, isContentEditable }) as unknown as EventTarget;

describe("isFormControl", () => {
  it("is true for form controls and editable content", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT", "BUTTON"]) {
      expect(isFormControl(el(tag))).toBe(true);
    }
    expect(isFormControl(el("DIV", true))).toBe(true);
  });

  it("is false for plain elements and null", () => {
    expect(isFormControl(el("DIV"))).toBe(false);
    expect(isFormControl(el("VIDEO"))).toBe(false);
    expect(isFormControl(null)).toBe(false);
  });
});
