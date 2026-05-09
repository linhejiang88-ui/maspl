import { describe, expect, it } from "vitest";
import { getBackend } from "../src/backend/index.js";

describe("getBackend", () => {
  it("resolves supported backends", () => {
    expect(getBackend("claude").name).toBe("claude");
    expect(getBackend("codex").name).toBe("codex");
  });
});
