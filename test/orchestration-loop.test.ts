import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentBackend, AgentRunParams } from "../src/backend/types.js";
import { defaultRolesYaml } from "../src/config/default-roles.js";
import { parseRolesConfig } from "../src/config/roles.js";
import { createSessionLog } from "../src/logging/session-log.js";
import { runOrchestration } from "../src/orchestration/loop.js";

describe("runOrchestration", () => {
  it("lets Orchestrator choose each next agent and task", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-test" });
    const calls: Array<{ agent: string; task: string }> = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nImplement the goal.";
        }
        if (params.agent === "exec") return "Exec done";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview Exec done.";
        }
        if (params.agent === "review") return "Review done";
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge Exec and Review.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: done.";
        return "NEXT_AGENT: done\nTASK:\nAll done.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async () => "unused"
    });

    expect(result).toBe("All done.");
    expect(calls.map((call) => call.agent)).toEqual([
      "orchestrator",
      "exec",
      "orchestrator",
      "review",
      "orchestrator",
      "judge",
      "orchestrator"
    ]);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("Orchestrator Agent -> Exec Agent");
    expect(content).toContain("Exec Agent -> Orchestrator Agent");
    expect(content).toContain("Orchestrator Agent -> Review Agent");
    expect(content).toContain("Review Agent -> Orchestrator Agent");
    expect(content).toContain("Orchestrator Agent -> Judge Agent");
    expect(content).toContain("Judge Agent -> Orchestrator Agent");
  });

  it("retries invalid Orchestrator dispatch instead of treating it as done", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-invalid-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-invalid-test" });
    const calls: Array<{ agent: string; task: string }> = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (calls.length === 1) {
          return "I think we should start with implementation.";
        }
        return "NEXT_AGENT: done\nTASK:\nRecovered final result.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async () => "unused"
    });

    expect(result).toBe("Recovered final result.");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.task).toContain("previous dispatch did not match");

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("dispatch output did not match");
  });

  it("fails when Orchestrator dispatch remains invalid after retry", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-invalid-fail-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-invalid-fail-test" });

    const backend: AgentBackend = {
      name: "fake",
      async runAgent() {
        return "still invalid";
      }
    };

    await expect(
      runOrchestration({
        backend,
        goal: "test",
        workspace,
        roles,
        log,
        askHuman: async () => "unused"
      })
    ).rejects.toThrow("invalid dispatch format");
  });
});
