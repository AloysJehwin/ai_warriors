import { describe, expect, it } from "vitest";
import library from "../../src/library/templates.json" with { type: "json" };
import { evaluateCriteria } from "../../src/pipelines/criteria.js";
import { edges, predecessors, renumber, validateSpec } from "../../src/pipelines/graph.js";
import type { StageSpec } from "../../src/domain/types.js";

const discrete = library.templates.find((t) => t.key === "discrete-assembly")!.stages as unknown as StageSpec[];

describe("pipeline graph (design rules)", () => {
  it("splits, keeps parallel lanes, and merges like the Discrete assembly flow", () => {
    const e = edges(discrete).map((x) => `${x.from}>${x.to}`);
    expect(e).toEqual(expect.arrayContaining(["01>02a", "01>02b", "02a>03a", "02b>03b", "03a>04", "03b>04", "04>05a", "04>05b", "05a>06", "05b>06", "06>07", "07>08"]));
    expect(e).not.toContain("02a>03b");
    expect(predecessors(discrete).get("04")).toEqual(["03a", "03b"]);
  });
  it("every library template is valid", () => {
    for (const t of library.templates) expect(validateSpec(t.stages as unknown as StageSpec[], t.rework), t.name).toEqual([]);
  });
  it("renumbers columns and lanes after editing", () => {
    const r = renumber([{ column: 1 }, { column: 3 }, { column: 3 }, { column: 7 }]);
    expect(r.map((s) => s.code)).toEqual(["01", "02a", "02b", "03"]);
  });
  it("rejects bad rework loops and duplicate codes", () => {
    expect(validateSpec(discrete, { from: "04", to: "06" })).toContain("A rework loop must send units back to an earlier stage");
    expect(validateSpec([...discrete, discrete[0]!], null)).toContain("Stage code 01 is used twice");
  });
});

describe("success criteria use measured values only", () => {
  const crit = [
    { label: "First-pass yield", op: ">=", target: 97, unit: "%" },
    { label: "Scrap", op: "<=", target: 1, unit: "%" },
    { label: "Cycle time", op: "<=", target: 62, unit: "s" },
    { label: "Cpk (critical dim.)", op: ">=", target: 1.33, unit: "" },
  ] as const;
  it("passes, fails and leaves unmeasured criteria to a person", () => {
    const r = evaluateCriteria([...crit], { good: 196, scrap: 4, durationMin: 200, activeOee: null });
    expect(r.map((x) => x.ok)).toEqual([true, false, true, null]);
    expect(r[0]!.actual).toBe("98.0%");
    expect(r[3]!.actual).toBeNull();
  });
});
