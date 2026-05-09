import { describe, expect, it } from "vitest";
import { defaultRolesYaml } from "../src/config/default-roles.js";
import { parseRolesConfig } from "../src/config/roles.js";

describe("parseRolesConfig", () => {
  it("parses the default roles file", () => {
    const config = parseRolesConfig(defaultRolesYaml);

    expect(config.main.prompt).toContain("Main Agent");
    expect(config.reviewer.description).toContain("Independent code reviewer");
    expect(config.runtime.allowedTools).toContain("Agent");
    expect(config.runtime.allowedTools).toContain("mcp__maspl__ask_human");
  });

  it("rejects missing reviewer", () => {
    expect(() =>
      parseRolesConfig(`
main:
  prompt: hello
`)
    ).toThrow(/reviewer/);
  });
});
