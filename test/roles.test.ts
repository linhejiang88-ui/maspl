import { describe, expect, it } from "vitest";
import { defaultRolesYaml } from "../src/config/default-roles.js";
import { parseRolesConfig } from "../src/config/roles.js";

describe("parseRolesConfig", () => {
  it("parses the default roles file", () => {
    const config = parseRolesConfig(defaultRolesYaml);

    expect(config.orchestrator.prompt).toContain("Orchestrator Agent");
    expect(config.exec.prompt).toContain("Exec Agent");
    expect(config.review.description).toContain("Clarifies the user problem");
    expect(config.review.prompt).toContain("problem clarifier");
    expect(config.review.prompt).toContain("scope reducer");
    expect(config.review.prompt).toContain("skeptic");
    expect(config.review.prompt).toContain("case builder");
    expect(config.review.prompt).toContain("Required output protocol");
    expect(config.review.prompt).toContain("BLOCKING_FINDINGS");
    expect(config.judge.prompt).toContain("required Review protocol");
    expect(config.exec.prompt).toContain("CLARIFICATION_BLOCKED");
    expect(config.orchestrator.prompt).toContain("PERMISSION_BLOCKED");
    expect(config.judge.prompt).toContain("Judge Agent");
    expect(config.orchestrator.tools).toEqual([]);
    expect(config.orchestrator.backend).toBe("codex");
    expect(config.exec.backend).toBe("codex");
    expect(config.review.backend).toBe("claude");
    expect(config.judge.backend).toBe("codex");
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

  it("uses the strict Judge protocol for reviewer fallback configs", () => {
    const config = parseRolesConfig(`
main:
  prompt: main agent
reviewer:
  description: reviewer agent
  prompt: reviewer agent
`);

    expect(config.judge.prompt).toContain("Modification direction");
    expect(config.judge.prompt).toContain("Default if blank");
    expect(config.judge.prompt).toContain("Instruction to Orchestrator");
  });

  it("fills default per-agent backends when omitted", () => {
    const config = parseRolesConfig(`
orchestrator:
  description: dispatch
  prompt: orchestrator
exec:
  description: execute
  prompt: exec
review:
  description: review
  prompt: review
judge:
  description: judge
  prompt: judge
`);

    expect(config.orchestrator.backend).toBe("codex");
    expect(config.exec.backend).toBe("codex");
    expect(config.review.backend).toBe("claude");
    expect(config.judge.backend).toBe("codex");
  });
});
