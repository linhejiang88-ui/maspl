import { describe, expect, it } from "vitest";
import { defaultRolesYaml } from "../src/config/default-roles.js";
import { parseRolesConfig } from "../src/config/roles.js";

describe("parseRolesConfig", () => {
  it("parses the default roles file", () => {
    const config = parseRolesConfig(defaultRolesYaml);

    expect(config.orchestrator.prompt).toContain("Orchestrator Agent");
    expect(config.exec.prompt).toContain("Exec Agent");
    expect(config.review.description).toContain("Reviews Exec Agent");
    expect(config.judge.prompt).toContain("Judge Agent");
    expect(config.orchestrator.tools).toEqual([]);
    expect(config.runtime.allowedTools).toContain("Read");
    expect(config.runtime.allowedTools).not.toContain("mcp__maspl__ask_human");
  });

  it("rejects missing required agents", () => {
    expect(() =>
      parseRolesConfig(`
orchestrator:
  description: dispatch
  prompt: hello
`)
    ).toThrow(/exec/);
  });
});
