import { describe, expect, it } from "vitest";

import { safeNext } from "../src/lib/redirect";

const origin = "https://ticker.example";

describe("safeNext", () => {
  it("keeps a path on this site, with its query", () => {
    expect(safeNext("/leagues?join=AB12CD", origin)).toBe("/leagues?join=AB12CD");
    expect(safeNext("/trade", origin)).toBe("/trade");
  });

  it("refuses anything a browser would send to another host", () => {
    for (const next of [
      "/\\evil.example",
      "/%5Cevil.example",
      "/%09/evil.example",
      "/\t/evil.example",
      "//evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "/",
      "",
      null,
    ])
      expect(safeNext(next, origin)).toBe("/trade");
  });
});
