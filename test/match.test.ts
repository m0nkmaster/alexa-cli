import { describe, it, expect } from "vitest";
import {
  AmbiguousMatchError,
  controlExitCode,
  controlResultFlags,
  matchByName,
  resolveUniqueMatch,
} from "../src/match.js";

describe("matchByName", () => {
  const items = [
    { name: "Kitchen spot 1" },
    { name: "Kitchen spot 2" },
    { name: "Lounge lamp" },
    { name: "Landing lamp" },
    { name: "Office Echo" },
  ];
  const getName = (i: { name: string }) => i.name;

  it("prefers exact over startsWith/contains", () => {
    const result = matchByName([{ name: "Kitchen" }, { name: "Kitchen spot 1" }], "Kitchen", getName);
    expect(result.status).toBe("matched");
    if (result.status === "matched") {
      expect(result.kind).toBe("exact");
      expect(result.item.name).toBe("Kitchen");
    }
  });

  it("uses startsWith when no exact match", () => {
    const result = matchByName(items, "Office", getName);
    expect(result.status).toBe("matched");
    if (result.status === "matched") {
      expect(result.kind).toBe("startsWith");
      expect(result.item.name).toBe("Office Echo");
    }
  });

  it("uses contains when no exact or startsWith", () => {
    const result = matchByName(items, "unge", getName);
    expect(result.status).toBe("matched");
    if (result.status === "matched") {
      expect(result.kind).toBe("contains");
      expect(result.item.name).toBe("Lounge lamp");
    }
  });

  it("reports ambiguous contains matches with suggestions", () => {
    const result = matchByName(items, "lamp", getName);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.kind).toBe("contains");
      expect(result.suggestions).toEqual(["Landing lamp", "Lounge lamp"]);
    }
  });

  it("reports ambiguous startsWith matches", () => {
    const result = matchByName(items, "Kitchen spot", getName);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.kind).toBe("startsWith");
      expect(result.suggestions).toHaveLength(2);
    }
  });

  it("returns none when no match", () => {
    expect(matchByName(items, "garage", getName).status).toBe("none");
  });
});

describe("resolveUniqueMatch", () => {
  it("returns the unique match", () => {
    const items = [{ name: "Office Echo" }];
    expect(resolveUniqueMatch(items, "Office", (i) => i.name)?.name).toBe("Office Echo");
  });

  it("throws AmbiguousMatchError with suggestions", () => {
    const items = [{ name: "Lounge lamp" }, { name: "Landing lamp" }];
    expect(() => resolveUniqueMatch(items, "lamp", (i) => i.name)).toThrow(AmbiguousMatchError);
    try {
      resolveUniqueMatch(items, "lamp", (i) => i.name);
    } catch (e) {
      expect(e).toBeInstanceOf(AmbiguousMatchError);
      expect((e as AmbiguousMatchError).suggestions).toEqual(["Landing lamp", "Lounge lamp"]);
    }
  });

  it("returns null when none", () => {
    expect(resolveUniqueMatch([{ name: "A" }], "z", (i) => i.name)).toBeNull();
  });
});

describe("controlResultFlags / controlExitCode", () => {
  it("marks full success", () => {
    expect(controlResultFlags(3, 0)).toEqual({ success: true, partial: false });
    expect(controlExitCode(3, 0)).toBe(0);
  });

  it("marks partial failure", () => {
    expect(controlResultFlags(2, 1)).toEqual({ success: false, partial: true });
    expect(controlExitCode(2, 1)).toBe(2);
  });

  it("marks total failure", () => {
    expect(controlResultFlags(0, 2)).toEqual({ success: false, partial: false });
    expect(controlExitCode(0, 2)).toBe(1);
    expect(controlExitCode(0, 0)).toBe(1);
  });
});
