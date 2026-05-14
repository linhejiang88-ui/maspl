import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionLog } from "../src/logging/session-log.js";

const workspace = path.join("/private/tmp", `maspl-test-${process.pid}`);

describe("createSessionLog", () => {
  afterEach(async () => {
    // Left in place intentionally when cleanup fails; /private/tmp is ephemeral.
  });

  it("creates a session markdown file", async () => {
    await mkdir(workspace, { recursive: true });
    const workingDirectory = path.join(workspace, "current-project");
    await mkdir(workingDirectory, { recursive: true });
    const finalResultPath = path.join(workspace, "result.md");
    const log = await createSessionLog({
      workspace,
      workingDirectory,
      finalResultPath,
      goal: "ship it",
      runId: "test-run"
    });

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
    expect(content).toContain("Agent Session Registered");
    expect(content).toContain("Result Artifact");
    expect(content).toContain('"type": "result"');
    expect(content).toContain("Orchestrator Agent handoff");
    expect(content).toContain("Orchestrator Agent -> Review Agent");
    expect(content).toContain("- [");
    expect(content).toContain("]-[Orchestrator Agent]-[handoff]-[Orchestrator Agent -> Review Agent]");
    expect(content).toMatch(/- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+08:00\]-\[Orchestrator Agent\]/);
    expect(content).not.toMatch(/- \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    expect(content).not.toMatch(/- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z\]/);
    expect(content).toMatch(/- time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+08:00/);
    expect(content).toContain("[compressed: omitted");
    expect(content).toContain("````");

    const result = await readFile(log.resultPath, "utf8");
    const finalResult = await readFile(log.finalResultPath, "utf8");
    expect(finalResult).toBe(result);
    expect(log.finalResultPath).toBe(finalResultPath);
    expect(result).toContain("## Current Working Directory");
    expect(result).toContain(workingDirectory);
    expect(result).toContain("## MASPL Workspace");
    expect(result).toContain(workspace);
    expect(result).toContain("## Final Result Document");
    expect(result).toContain(finalResultPath);
    expect(result).toContain("## Internal Run Result Copy");
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

  it("prints backend session ids once and suppresses generated placeholders", async () => {
    await mkdir(workspace, { recursive: true });
    const log = await createSessionLog({
      workspace,
      goal: "session logging",
      runId: "session-print-test"
    });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let sessionLines: string[] = [];

    try {
      await log.registerAgentSession({
        agent: "review",
        backend: "claude"
      });
      await log.registerAgentSession({
        agent: "review",
        backend: "claude",
        sessionId: "real-review-session"
      });
      await log.registerAgentSession({
        agent: "review",
        backend: "claude",
        sessionId: "real-review-session"
      });
      sessionLines = consoleLog.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("]-[Review Agent]-[session]-["));
    } finally {
      consoleLog.mockRestore();
    }

    expect(sessionLines).toEqual([expect.stringContaining("real-review-session")]);
    expect(sessionLines[0]).not.toContain("maspl-session-print-test-review");
  });

  it("suppresses noisy SDK lifecycle progress in realtime output", async () => {
    await mkdir(workspace, { recursive: true });
    const log = await createSessionLog({
      workspace,
      goal: "quiet progress",
      runId: "quiet-progress-test"
    });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let lines: string[] = [];

    try {
      await log.appendTrace({
        agent: "Exec Agent",
        phase: "progress",
        status: "running",
        summary: "Codex turn started."
      });
      await log.appendTrace({
        agent: "Claude SDK",
        phase: "progress",
        status: "running",
        summary: "Claude system event: init"
      });
      await log.appendTrace({
        agent: "Exec Agent",
        phase: "output",
        status: "completed",
        summary: "Exec produced output.",
        output: "done"
      });
      lines = consoleLog.mock.calls.map((call) => String(call[0]));
    } finally {
      consoleLog.mockRestore();
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("]-[Exec Agent]-[output]-[done]");

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("Codex turn started.");
    expect(content).toContain("Claude system event: init");
  });

  it("prints Runtime error summaries in realtime output", async () => {
    await mkdir(workspace, { recursive: true });
    const log = await createSessionLog({
      workspace,
      goal: "foreground errors",
      runId: "foreground-error-test"
    });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let lines: string[] = [];

    try {
      await log.appendTrace({
        agent: "Runtime",
        phase: "error",
        status: "failed",
        summary: "Runtime blocked EXECUTE_APPROVED_PLAN. Human approval is required after Judge SATISFIED.",
        input: "EXECUTE_APPROVED_PLAN: run"
      });
      lines = consoleLog.mock.calls.map((call) => String(call[0]));
    } finally {
      consoleLog.mockRestore();
    }

    expect(lines).toEqual([
      expect.stringContaining(
        "]-[Runtime]-[error]-[Runtime blocked EXECUTE_APPROVED_PLAN. Human approval is required after Judge SATISFIED.]"
      )
    ]);
    expect(lines[0]).toMatch(/^\- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+08:00\]/);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("Runtime blocked EXECUTE_APPROVED_PLAN");
    expect(content).toContain("EXECUTE_APPROVED_PLAN: run");
  });

  it("does not omit short realtime previews", async () => {
    await mkdir(workspace, { recursive: true });
    const log = await createSessionLog({
      workspace,
      goal: "short preview",
      runId: "short-preview-test"
    });
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const shortInput = `Review output ${"x".repeat(134)} done.`;
    let lines: string[] = [];

    try {
      await log.appendTrace({
        agent: "Runtime",
        phase: "input",
        status: "running",
        summary: "Runtime received short input.",
        input: shortInput
      });
      lines = consoleLog.mock.calls.map((call) => String(call[0]));
    } finally {
      consoleLog.mockRestore();
    }

    const inputLine = lines.find((line) => line.includes("]-[Runtime]-[input]-[")) ?? "";
    expect(inputLine).toContain(shortInput);
    expect(inputLine).not.toContain("[omitted");
  });
});
