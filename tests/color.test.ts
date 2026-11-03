import { describe, expect, test } from "bun:test";
import { paint, status, useColor } from "../src/core/color.ts";
import { formatControls } from "../src/ops/ops.ts";

describe("color", () => {
  test("only on a terminal; NO_COLOR wins, FORCE_COLOR forces, a dumb terminal stays plain", () => {
    expect(useColor({}, true)).toBe(true);
    expect(useColor({}, false)).toBe(false);
    expect(useColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(false);
    expect(useColor({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(useColor({ FORCE_COLOR: "0" }, false)).toBe(false);
    expect(useColor({ TERM: "dumb" }, true)).toBe(false);
  });

  test("status words keep their width, coloured or not", () => {
    expect([status(true, false), status(false, false), status(null, false)]).toEqual(["ok  ", "FAIL", "?   "]);
    expect(status(true, true)).toBe("\x1b[32mok  \x1b[0m");
    expect(status(false, true)).toBe("\x1b[31mFAIL\x1b[0m");
    expect(paint("x", "dim", false)).toBe("x");
  });

  test("ops controls are plain text unless asked", () => {
    const c = [{ id: "firewall", ok: false, detail: "ufw disabled" }];
    expect(formatControls(c)).toEqual(["FAIL firewall         ufw disabled"]);
    expect(formatControls(c, true)[0]).toContain("\x1b[31mFAIL\x1b[0m");
  });
});
