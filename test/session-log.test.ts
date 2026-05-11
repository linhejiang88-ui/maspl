import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionLog } from "../src/logging/session-log.js";

const workspace = path.join("/private/tmp", `maspl-test-${process.pid}`);

describe("createSessionLog", () => {
  afterEach(async () => {
    // Left in place intentionally when cleanup fails; /private/tmp is ephemeral.
  });

  it("creates a session markdown file", async () => {
    await mkdir(workspace, { recursive: true });
    const log = await createSessionLog({
      workspace,
      goal: "ship it",
      runId: "test-run"
    });

    await log.appendSection("Final Result", "done");
    await log.appendEvent("SDK Message", { type: "result" });
    const generatedSession = await log.registerAgentSession({
      agent: "exec",
      backend: "codex"
    });
    const backendSession = await log.registerAgentSession({
      agent: "review",
      backend: "claude",
      sessionId: "claude-review-session"
    });
    await log.writeResult("created app.js\n\nRun with `node app.js`.");
    await log.appendTrace({
      agent: "Orchestrator Agent",
      phase: "handoff",
      status: "completed",
      summary: "Orchestrator delegated exec output to Review Agent.",
      fromAgent: "Orchestrator Agent",
      toAgent: "Review Agent",
      input: `head-${"x".repeat(4_000)}-tail`,
      output: "review done\n```ts\nconst ok = true;\n```"
    });

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("# MASPL Session test-run");
    expect(content).toContain("ship it");
    expect(content).toContain("Final Result");
    expect(content).toContain("Agent Session Registered");
    expect(content).toContain("Result Artifact");
    expect(content).toContain('"type": "result"');
    expect(content).toContain("Orchestrator Agent handoff");
    expect(content).toContain("Orchestrator Agent -> Review Agent");
    expect(content).toContain("- [");
    expect(content).toContain("]-[Orchestrator Agent]-[input]-[head-");
    expect(content).toContain("-tail]");
    expect(content).toContain("]-[Orchestrator Agent]-[output]-[review done");
    expect(content).toContain("]-[Orchestrator Agent]-[handoff]-[Orchestrator Agent -> Review Agent]");
    expect(content).toContain("]-[Orchestrator Agent]-[handoff]-[end]");
    expect(content).toContain("[compressed: omitted");
    expect(content).toContain("````");

    const result = await readFile(log.resultPath, "utf8");
    expect(result).toContain("## Project Workspace");
    expect(result).toContain(workspace);
    expect(result).toContain("## Result Artifact");
    expect(result).toContain(log.resultPath);
    expect(result).toContain("## Output And Usage");
    expect(result).toContain("created app.js");
    expect(result).toContain("## How To Use Or Verify");
    expect(result).toContain(".maspl/runs/test-run/result.md");

    const agentSessions = JSON.parse(await readFile(log.agentSessionsPath, "utf8"));
    expect(agentSessions.agents.exec.sessionId).toBe(generatedSession.sessionId);
    expect(agentSessions.agents.exec.source).toBe("generated");
    expect(agentSessions.agents.review.sessionId).toBe(backendSession.sessionId);
    expect(agentSessions.agents.review.source).toBe("backend");
  });
});
