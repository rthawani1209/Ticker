import { describe, expect, it } from "vitest";

import { visitorIp } from "@/lib/client-ip";

describe("visitorIp", () => {
  it("takes the only entry", () => {
    expect(visitorIp("203.0.113.7")).toBe("203.0.113.7");
    expect(visitorIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it("ignores entries the browser put in front", () => {
    expect(visitorIp("1.2.3.4, 203.0.113.7")).toBe("203.0.113.7");
  });

  it("rejects missing or junk values", () => {
    expect(visitorIp(null)).toBeNull();
    expect(visitorIp("")).toBeNull();
    expect(visitorIp("1.2.3.4, not-an-ip")).toBeNull();
  });
});
