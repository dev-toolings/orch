import { describe, expect, test } from "bun:test";
import { loadProfile } from "../src/core/profile.ts";
import { laneBudget, type MachineFigures } from "../src/lanes/budget.ts";

const max20 = loadProfile("max20").limits;
const lean = loadProfile("lean").limits;

describe("lane budget", () => {
  test("16 cores and 23 GiB available are limited by CPU and the ceiling", () => {
    const machine: MachineFigures = { cores: 16, memAvailableGib: 23 };
    expect(laneBudget(max20, machine)).toEqual({ budget: 8, cpu: 8, ram: 32, ceiling: 8, limitedBy: "cpu" });
  });

  test("16 cores and 6 GiB available are limited by RAM", () => {
    const machine: MachineFigures = { cores: 16, memAvailableGib: 6 };
    expect(laneBudget(max20, machine)).toEqual({ budget: 1, cpu: 8, ram: -2, ceiling: 8, limitedBy: "ram" });
  });

  test("a tiny machine keeps the budget at one", () => {
    const machine: MachineFigures = { cores: 1, memAvailableGib: 1 };
    expect(laneBudget(max20, machine)).toMatchObject({ budget: 1 });
  });

  test("lean caps a roomy machine at two", () => {
    const machine: MachineFigures = { cores: 16, memAvailableGib: 64 };
    expect(laneBudget(lean, machine)).toEqual({ budget: 2, cpu: 8, ram: 117, ceiling: 2, limitedBy: "ceiling" });
  });
});
