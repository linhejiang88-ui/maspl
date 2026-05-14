import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentBackend, AgentRunParams } from "../src/backend/types.js";
import { defaultRolesYaml } from "../src/config/default-roles.js";
import { parseRolesConfig } from "../src/config/roles.js";
import { createSessionLog } from "../src/logging/session-log.js";
import { runOrchestration } from "../src/orchestration/loop.js";

describe("runOrchestration", () => {
  it("uses per-agent backends from roles config", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-agent-backends-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-agent-backends-test" });
    const calls: Array<{ backend: string; agent: string }> = [];

    const codexBackend: AgentBackend = {
      name: "codex",
      async runAgent(params: AgentRunParams) {
        calls.push({ backend: "codex", agent: params.agent });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: review\nTASK:\nReview something.";
        }
        return "NEXT_AGENT: done\nTASK:\nAll done.";
      }
    };
    const claudeBackend: AgentBackend = {
      name: "claude",
      async runAgent(params: AgentRunParams) {
        calls.push({ backend: "claude", agent: params.agent });
        return validReviewOutput();
      }
    };

    const result = await runOrchestration({
      backends: {
        claude: claudeBackend,
        codex: codexBackend
      },
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async () => "unused"
    });

    expect(result).toBe("All done.");
    expect(calls).toEqual([
      { backend: "codex", agent: "orchestrator" },
      { backend: "claude", agent: "review" },
      { backend: "codex", agent: "orchestrator" }
    ]);
  });

  it("passes the current working directory to agents and includes it in prompts", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-working-dir-${process.pid}`);
    const workingDirectory = path.join(workspace, "project");
    await mkdir(workingDirectory, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-working-dir-test" });
    const calls: Array<{ agent: string; workingDirectory: string; task: string }> = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, workingDirectory: params.workingDirectory, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          expect(params.task).toContain(`Current working directory:\n${workingDirectory}`);
          expect(params.task).toContain(`MASPL workspace:\n${workspace}`);
          return "NEXT_AGENT: exec\nTASK:\nImplement the goal.";
        }
        if (params.agent === "exec") {
          expect(params.task).toContain(`Current working directory:\n${workingDirectory}`);
          expect(params.task).toContain(`MASPL workspace:\n${workspace}`);
          return "Exec done";
        }
        return "NEXT_AGENT: done\nTASK:\nAll done.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      workingDirectory,
      roles,
      log,
      askHuman: async () => "unused"
    });

    expect(result).toBe("All done.");
    expect(calls.map((call) => call.workingDirectory)).toEqual([workingDirectory, workingDirectory, workingDirectory]);
  });

  it("allows backend option to override per-agent backend config", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-backend-override-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-backend-override-test" });
    const calls: Array<{ backend: string; agent: string }> = [];

    const codexBackend: AgentBackend = {
      name: "codex",
      async runAgent(params: AgentRunParams) {
        calls.push({ backend: "codex", agent: params.agent });
        if (calls.length === 1) return "NEXT_AGENT: review\nTASK:\nReview something.";
        return "NEXT_AGENT: done\nTASK:\nAll done.";
      }
    };
    const claudeBackend: AgentBackend = {
      name: "claude",
      async runAgent(params: AgentRunParams) {
        calls.push({ backend: "claude", agent: params.agent });
        return "unexpected";
      }
    };

    const result = await runOrchestration({
      backends: {
        claude: claudeBackend,
        codex: codexBackend
      },
      backendOverride: "codex",
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async () => "unused"
    });

    expect(result).toBe("All done.");
    expect(calls).toEqual([
      { backend: "codex", agent: "orchestrator" },
      { backend: "codex", agent: "review" },
      { backend: "codex", agent: "orchestrator" }
    ]);
  });

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

  it("blocks EXECUTE_APPROVED_PLAN until Review and Judge pass the plan", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-plan-gate-block-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-plan-gate-block-test" });
    const calls: Array<{ agent: string; task: string }> = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec") return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: implement now.";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after runtime gate.";
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

    expect(result).toBe("Stopped after runtime gate.");
    expect(calls.map((call) => call.agent)).toEqual(["orchestrator", "exec", "orchestrator", "orchestrator"]);
    expect(calls.some(isExecExecuteApprovedPlanCall)).toBe(false);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("Runtime blocked EXECUTE_APPROVED_PLAN");
  });

  it("blocks EXECUTE_APPROVED_PLAN when no PLAN_ONLY plan is active", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-execute-without-plan-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-execute-without-plan-test" });
    const calls: Array<{ agent: string; task: string }> = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: implement without planning.";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after missing plan gate.";
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

    expect(result).toBe("Stopped after missing plan gate.");
    expect(calls.some(isExecExecuteApprovedPlanCall)).toBe(false);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("No PLAN_ONLY plan is active");
    expect(content).toContain("run PLAN_ONLY, Review, Judge, and Human approval");
  });

  it("injects clarification requirements into Exec PLAN_ONLY tasks", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-exec-plan-instruction-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-exec-plan-instruction-test" });
    let execTask = "";

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        if (params.agent === "orchestrator" && !execTask) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: define a plan for an ambiguous goal.";
        }
        if (params.agent === "exec") {
          execTask = params.task;
          return "Plan ready.";
        }
        return "NEXT_AGENT: done\nTASK:\nDone.";
      }
    };

    await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async () => "unused"
    });

    expect(execTask).toContain("Exec PLAN_ONLY protocol");
    expect(execTask).toContain("CLARIFICATION_BLOCKED");
    expect(execTask).toContain("Do not return PERMISSION_BLOCKED merely because future execution may need");
    expect(execTask).toContain("numbered options with impact");
    expect(execTask).toContain("Default if blank");
  });

  it("tells Exec PLAN_ONLY to list future API permissions instead of blocking", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-exec-plan-permission-guidance-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-exec-plan-permission-guidance-test" });
    let execTask = "";

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        if (params.agent === "orchestrator" && !execTask) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: plan an API-backed data processing run.";
        }
        if (params.agent === "exec") {
          execTask = params.task;
          return "Plan ready with required capabilities listed.";
        }
        return "NEXT_AGENT: done\nTASK:\nDone.";
      }
    };

    await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async () => "unused"
    });

    expect(execTask).toContain("required capabilities/approvals in the plan instead");
    expect(execTask).toContain("Return PERMISSION_BLOCKED in PLAN_ONLY only when the planning step itself");
  });

  it("requires clarification for very broad short PLAN_ONLY research goals", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-broad-goal-clarification-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "调研小学数学", runId: "loop-broad-goal-clarification-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    const questions: string[] = [];
    let askedForClarification = false;

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: 调研小学数学。";
        }
        if (params.agent === "exec") {
          expect(params.task).toContain("Initial clarification gate");
          expect(params.task).toContain("too short/open-ended");
          return "Plan ready without asking the human.";
        }
        if (params.agent === "orchestrator" && params.task.includes("CLARIFICATION_REQUIRED") && !askedForClarification) {
          askedForClarification = true;
          return `NEXT_AGENT: human
TASK:
Question: 请确认小学数学调研的用途、受众、输出形式和范围。
Options:
1. 给家长看的选课/学习规划调研。
2. 给老师看的课程/教研调研。
3. 给产品/内容团队看的市场和需求调研。
Default if blank: 先按给家长看的学习规划调研处理。`;
        }
        return "NEXT_AGENT: done\nTASK:\nClarification requested.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "调研小学数学",
      workspace,
      roles,
      log,
      askHuman: async (question) => {
        questions.push(question);
        return "1";
      }
    });

    expect(result).toBe("Clarification requested.");
    expect(questions).toHaveLength(1);
    expect(calls.filter((call) => call.agent === "exec")).toHaveLength(1);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("CLARIFICATION_REQUIRED");
  });

  it("allows EXECUTE_APPROVED_PLAN after Review, Judge, and Human approval pass", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-plan-gate-pass-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-plan-gate-pass-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    const questions: string[] = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec" && params.task.includes("PLAN_ONLY")) {
          return "Plan ready.\nStep 1: inspect inputs.\nStep 2: produce the approved artifact.";
        }
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") return validReviewOutput();
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: plan reviewed and acceptable.";
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN：implement the reviewed plan.";
        }
        if (params.agent === "exec" && params.task.includes("EXECUTE_APPROVED_PLAN")) return "Implemented.";
        return "NEXT_AGENT: done\nTASK:\nAll done.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async (question) => {
        questions.push(question);
        return "Approve execution - continue with EXECUTE_APPROVED_PLAN.";
      }
    });

    expect(result).toBe("All done.");
    expect(calls.some(isExecExecuteApprovedPlanCall)).toBe(true);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("Judge returned SATISFIED");
    expect(questions[0]).toContain("Approved PLAN_ONLY output:");
    expect(questions[0]).toContain("Plan ready.\nStep 1: inspect inputs.\nStep 2: produce the approved artifact.");
    expect(questions[0]).toContain("Default if blank: Approve execution.");
  });

  it("keeps PLAN_ONLY output in approval prompt after Review and Judge retries", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-plan-review-judge-retry-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-plan-review-judge-retry-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    const questions: string[] = [];
    const planOutput = "Original PLAN_ONLY output that must survive invalid Review and Judge retries.";

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec" && params.taskInstruction?.startsWith("PLAN_ONLY")) return planOutput;
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review" && calls.length === 4) return "Looks good.";
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: review\nTASK:\nReview the same PLAN_ONLY proposal again with the required protocol.";
        }
        if (params.agent === "review" && calls.length === 6) return validReviewOutput();
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge" && calls.length === 8) return "SATISFIED";
        if (params.agent === "orchestrator" && calls.length === 9) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the same reviewed plan again with the required protocol.";
        }
        if (params.agent === "judge" && calls.length === 10) {
          return "SATISFIED\nReason: plan reviewed and acceptable.";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after approval prompt.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async (question) => {
        questions.push(question);
        return "Do not execute - stop after the approved plan.";
      }
    });

    expect(result).toBe("Stopped after approval prompt.");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("Approved PLAN_ONLY output:");
    expect(questions[0]).toContain(planOutput);
    expect(questions[0]).not.toContain("(no PLAN_ONLY output recorded)");

    const content = await readFile(log.path, "utf8");
    expect(content).not.toContain("Runtime blocked Review approval");
    expect(content).toContain("Judge output did not satisfy the required protocol");
  });

  it("allows EXECUTE_APPROVED_PLAN after Chinese Human approval", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-plan-gate-chinese-approval-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-plan-gate-chinese-approval-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    const questions: string[] = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec" && params.task.includes("PLAN_ONLY")) return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") return validReviewOutput();
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: plan reviewed and acceptable.";
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: implement the reviewed plan.";
        }
        if (params.agent === "exec" && params.taskInstruction?.startsWith("EXECUTE_APPROVED_PLAN")) return "Implemented.";
        return "NEXT_AGENT: done\nTASK:\nAll done.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async (question) => {
        questions.push(question);
        return "批准执行：允许 Exec Agent 按已通过的计划执行快速调研，并在 `/Users/admin/work/github/tmp` 下产出调研报告。";
      }
    });

    expect(result).toBe("All done.");
    expect(questions).toHaveLength(1);
    expect(calls.some(isExecExecuteApprovedPlanCall)).toBe(true);

    const content = await readFile(log.path, "utf8");
    expect(content).not.toContain("Human approval is required after Judge SATISFIED");
  });

  it("replaces Orchestrator custom Human execution approval with the Runtime approval gate", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-runtime-owned-approval-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-runtime-owned-approval-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    const questions: string[] = [];
    const planOutput = "PLAN_ONLY: approved plan\n1. Run the full eval.\n2. Report the computed metric.";

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec" && params.task.includes("PLAN_ONLY")) return planOutput;
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") return validReviewOutput();
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: plan reviewed and acceptable.";
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: human\nTASK:\n请确认是否批准执行。\n1. 批准执行\n2. 暂不执行\nDefault if blank: 1";
        }
        if (params.agent === "orchestrator" && calls.length === 8) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN：人类已批准执行。请执行计划。";
        }
        if (params.agent === "exec" && params.task.includes("EXECUTE_APPROVED_PLAN")) return "Implemented.";
        return "NEXT_AGENT: done\nTASK:\nAll done.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async (question) => {
        questions.push(question);
        return "";
      }
    });

    expect(result).toBe("All done.");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("Approved PLAN_ONLY output:");
    expect(questions[0]).toContain(planOutput);
    expect(questions[0]).toContain("Default if blank: Approve execution.");
    expect(questions[0]).not.toContain("请确认是否批准执行");
    expect(calls.some(isExecExecuteApprovedPlanCall)).toBe(true);

    const content = await readFile(log.path, "utf8");
    expect(content).not.toContain("Human approval is required after Judge SATISFIED");
  });

  it("blocks EXECUTE_APPROVED_PLAN when Human does not approve after Judge is satisfied", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-plan-human-deny-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-plan-human-deny-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    const questions: string[] = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec" && params.task.includes("PLAN_ONLY")) return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") return validReviewOutput();
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: plan reviewed and acceptable.";
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: should be blocked.";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after human denied execution.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async (question) => {
        questions.push(question);
        return "Do not execute - stop after the approved plan.";
      }
    });

    expect(result).toBe("Stopped after human denied execution.");
    expect(questions).toHaveLength(1);
    expect(calls.some(isExecExecuteApprovedPlanCall)).toBe(false);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("Human approval is required after Judge SATISFIED");
  });

  it.each(["不批准执行", "不同意执行", "不允许执行"])(
    "blocks EXECUTE_APPROVED_PLAN when Chinese Human answer is %s",
    async (humanAnswer) => {
      const workspace = path.join("/private/tmp", `maspl-loop-plan-chinese-deny-${process.pid}-${humanAnswer}`);
      await mkdir(workspace, { recursive: true });
      const roles = parseRolesConfig(defaultRolesYaml);
      const log = await createSessionLog({ workspace, goal: "test", runId: `loop-plan-chinese-deny-${humanAnswer}` });
      const calls: Array<{ agent: string; task: string }> = [];

      const backend: AgentBackend = {
        name: "fake",
        async runAgent(params: AgentRunParams) {
          calls.push({ agent: params.agent, task: params.task });
          if (params.agent === "orchestrator" && calls.length === 1) {
            return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
          }
          if (params.agent === "exec" && params.task.includes("PLAN_ONLY")) return "Plan ready.";
          if (params.agent === "orchestrator" && calls.length === 3) {
            return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
          }
          if (params.agent === "review") return validReviewOutput();
          if (params.agent === "orchestrator" && calls.length === 5) {
            return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
          }
          if (params.agent === "judge") return "SATISFIED\nReason: plan reviewed and acceptable.";
          if (params.agent === "orchestrator" && calls.length === 7) {
            return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: must remain blocked.";
          }
          return "NEXT_AGENT: done\nTASK:\nStopped after Chinese denial.";
        }
      };

      const result = await runOrchestration({
        backend,
        goal: "test",
        workspace,
        roles,
        log,
        askHuman: async () => humanAnswer
      });

      expect(result).toBe("Stopped after Chinese denial.");
      expect(calls.some(isExecExecuteApprovedPlanCall)).toBe(false);

      const content = await readFile(log.path, "utf8");
      expect(content).toContain("Human approval is required after Judge SATISFIED");
    }
  );

  it("blocks EXECUTE_APPROVED_PLAN and exposes Human feedback when Human requests plan changes", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-plan-human-modify-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-plan-human-modify-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    const questions: string[] = [];
    let sawModifyFeedback = false;

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && params.task.includes("PLAN_EXECUTION_MODIFY")) {
          sawModifyFeedback = true;
        }
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec" && params.task.includes("PLAN_ONLY")) return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") return validReviewOutput();
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: plan reviewed and acceptable.";
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: should be blocked after modify.";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after human requested plan changes.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async (question) => {
        questions.push(question);
        return "Modify plan/scope - return to PLAN_ONLY with human feedback.";
      }
    });

    expect(result).toBe("Stopped after human requested plan changes.");
    expect(questions).toHaveLength(1);
    expect(sawModifyFeedback).toBe(true);
    expect(calls.some(isExecExecuteApprovedPlanCall)).toBe(false);
  });

  it("does not ask for plan execution approval again after the approved plan has executed", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-plan-no-repeat-approval-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-plan-no-repeat-approval-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    const questions: string[] = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec" && params.task.includes("PLAN_ONLY")) return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") return validReviewOutput();
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: acceptable.";
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: implement the reviewed plan.";
        }
        if (params.agent === "exec" && params.task.includes("EXECUTE_APPROVED_PLAN")) return "Implemented.";
        if (params.agent === "orchestrator" && calls.length === 9) {
          return "NEXT_AGENT: review\nTASK:\nReview implementation result.";
        }
        if (params.agent === "orchestrator" && calls.length === 11) {
          return "NEXT_AGENT: judge\nTASK:\nJudge implementation result.";
        }
        return "NEXT_AGENT: done\nTASK:\nAll done.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async (question) => {
        questions.push(question);
        return "Approve execution - continue with EXECUTE_APPROVED_PLAN.";
      }
    });

    expect(result).toBe("All done.");
    expect(questions).toHaveLength(1);
    expect(calls.filter((call) => call.agent === "judge")).toHaveLength(2);
  });

  it("blocks finalization when Exec silently falls back after API failure during approved execution", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-exec-api-fallback-block-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-exec-api-fallback-block-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    const questions: string[] = [];
    let fallbackQuestionAsked = false;

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose an API-backed plan.";
        }
        if (params.agent === "exec" && params.task.includes("EXECUTE_APPROVED_PLAN")) {
          return "API 探测失败：环境无法解析 `modelx-api.shizhi-inc.com`。继续用 `--no-api` 的确定性本地规则生成预测。";
        }
        if (params.agent === "exec" && params.task.includes("PLAN_ONLY")) return "Plan requires external API.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") return "Plan is acceptable if API access works.";
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: plan is acceptable with API access.";
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: run API-backed prediction.";
        }
        if (params.agent === "orchestrator" && calls.length === 9) {
          return "NEXT_AGENT: done\nTASK:\nIncorrectly finalize after fallback.";
        }
        if (params.agent === "orchestrator" && params.task.includes("Human") && fallbackQuestionAsked) {
          return "NEXT_AGENT: done\nTASK:\nStopped after fallback confirmation.";
        }
        if (params.agent === "orchestrator" && params.task.includes("PERMISSION_BLOCKED") && !fallbackQuestionAsked) {
          fallbackQuestionAsked = true;
          return "NEXT_AGENT: human\nTASK:\nAPI fallback requires approval.\n1. fix environment and retry\n2. approve --no-api fallback\n3. stop\nDefault if blank: stop";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after fallback confirmation.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      maxTurns: 20,
      askHuman: async (question) => {
        questions.push(question);
        if (questions.length === 1) {
          return "Approve execution - continue with EXECUTE_APPROVED_PLAN.";
        }
        return "stop";
      }
    });

    expect(result).toBe("Stopped after fallback confirmation.");
    expect(questions).toHaveLength(2);
    expect(questions[1]).toContain("API fallback requires approval");

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("PERMISSION_BLOCKED");
    expect(content).toContain("unapproved fallback");
    expect(content).toContain("Runtime blocked finalization");
  });

  it("clears plan approval when Judge rejects the reviewed PLAN_ONLY proposal", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-plan-gate-judge-reject-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-plan-gate-judge-reject-test" });
    const calls: Array<{ agent: string; task: string }> = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose initial plan.";
        }
        if (params.agent === "exec") return "Initial plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview initial plan.";
        }
        if (params.agent === "review") return validReviewOutput();
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge initial plan.";
        }
        if (params.agent === "judge") return "NOT_SATISFIED\nReason: validation plan must be stronger.";
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: incorrectly execute rejected plan.";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after rejected plan gate.";
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

    expect(result).toBe("Stopped after rejected plan gate.");
    expect(calls.some(isExecExecuteApprovedPlanCall)).toBe(false);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("Runtime blocked EXECUTE_APPROVED_PLAN");
  });

  it("allows free-form Review feedback after Judge and Human approval pass", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-freeform-review-pass-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-freeform-review-pass-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    const questions: string[] = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec") return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") return "The plan is narrow enough. Main risk: verify output path after execution.";
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the free-form review.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: Review identified only a non-blocking verification note.";
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: implement after normalized judge decision.";
        }
        if (params.agent === "exec" && params.task.includes("EXECUTE_APPROVED_PLAN")) return "Implemented.";
        return "NEXT_AGENT: done\nTASK:\nAll done.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async (question) => {
        questions.push(question);
        return "Approve execution - continue with EXECUTE_APPROVED_PLAN.";
      }
    });

    expect(result).toBe("All done.");
    expect(questions).toHaveLength(1);
    expect(calls.some(isExecExecuteApprovedPlanCall)).toBe(true);

    const content = await readFile(log.path, "utf8");
    expect(content).not.toContain("Runtime blocked Review approval");
  });

  it("injects free-form skeptic guidance into Review tasks", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-review-checklist-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-review-checklist-test" });
    let reviewTask = "";

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        if (params.agent === "orchestrator" && !reviewTask) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") {
          reviewTask = params.task;
          return validReviewOutput();
        }
        return "NEXT_AGENT: done\nTASK:\nDone.";
      }
    };

    await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async () => "unused"
    });

    expect(reviewTask).toContain("Review guidance for this turn");
    expect(reviewTask).toContain("Do not merely agree with Exec");
    expect(reviewTask).toContain("You may write naturally");
    expect(reviewTask).toContain("ready for Judge");
    expect(reviewTask).not.toContain("BLOCKING_FINDINGS");
  });

  it("blocks Review approval that treats offline metrics as overall_metric acceptance evidence", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-review-offline-metric-block-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-review-offline-metric-block-test" });
    const calls: Array<{ agent: string; task: string }> = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: optimize overall_metric >= 0.9.";
        }
        if (params.agent === "exec") return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the execution result. 不要调用真实 API。";
        }
        if (params.agent === "review") {
          return "REVIEW_RESULT\nVerdict: APPROVE\nFindings: offline --no-api validation passes; 目标为 overall_metric >= 0.9。不要调用真实 API。";
        }
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: incorrectly accepted offline metric evidence.";
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: must remain blocked.";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after invalid metric evidence.";
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

    expect(result).toBe("Stopped after invalid metric evidence.");
    expect(calls.some(isExecExecuteApprovedPlanCall)).toBe(false);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("VALIDATION_BLOCKED");
    expect(content).toContain("real external API against the full eval set");
  });

  it("blocks Exec execution output that reports offline metric success", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-exec-offline-metric-block-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-exec-offline-metric-block-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    let executionDispatched = false;

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: optimize overall_metric >= 0.9.";
        }
        if (params.agent === "exec" && params.taskInstruction?.startsWith("PLAN_ONLY")) return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") return "Plan is narrow and validation requires full eval.";
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: plan reviewed and acceptable.";
        if (params.agent === "orchestrator" && !executionDispatched && params.task.includes("Human approved")) {
          executionDispatched = true;
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: run full eval.";
        }
        if (params.agent === "exec" && params.taskInstruction?.startsWith("EXECUTE_APPROVED_PLAN")) {
          return "Result: overall_metric=0.93 using offline --no-api local-rule eval.";
        }
        if (params.agent === "orchestrator" && calls.length === 10) {
          return "NEXT_AGENT: done\nTASK:\nStopped after invalid Exec metric evidence.";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after invalid Exec metric evidence.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async () => "approve"
    });

    expect(result).toBe("Stopped after invalid Exec metric evidence.");

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("VALIDATION_BLOCKED");
    expect(content).toContain("overall_metric/F1/eval target");
    expect(content).toContain("overall_metric=0.93");
  });

  it("blocks non-explicit Review continuation when offline metrics are the evidence", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-review-ready-offline-metric-block-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({
      workspace,
      goal: "test",
      runId: "loop-review-ready-offline-metric-block-test"
    });
    const calls: Array<{ agent: string; task: string }> = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: optimize overall_metric >= 0.9.";
        }
        if (params.agent === "exec") return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the execution result.";
        }
        if (params.agent === "review") {
          return "离线指标 overall_metric 0.93；未调用真实 API；建议继续交给 Judge。";
        }
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: done\nTASK:\nStopped after weak metric evidence.";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after weak metric evidence.";
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

    expect(result).toBe("Stopped after weak metric evidence.");

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("VALIDATION_BLOCKED");
    expect(content).toContain("离线指标 overall_metric 0.93");
  });

  it("blocks metric success that is only estimated or analyzed", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-estimated-metric-block-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-estimated-metric-block-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    let executionDispatched = false;

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: optimize overall_metric >= 0.9.";
        }
        if (params.agent === "exec" && params.taskInstruction?.startsWith("PLAN_ONLY")) return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") return "Plan is acceptable if the metric is actually computed.";
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: plan reviewed and acceptable.";
        if (params.agent === "orchestrator" && !executionDispatched && params.task.includes("Human approved")) {
          executionDispatched = true;
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: run full eval.";
        }
        if (params.agent === "exec" && params.taskInstruction?.startsWith("EXECUTE_APPROVED_PLAN")) {
          return "分析认为模型优化后 overall_metric=0.93，预计可以达到 0.9 目标。";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after estimated metric evidence.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async () => "approve"
    });

    expect(result).toBe("Stopped after estimated metric evidence.");

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("VALIDATION_BLOCKED");
    expect(content).toContain("actually computed");
    expect(content).toContain("分析认为模型优化后 overall_metric=0.93");
  });

  it("does not block legacy-shaped Review feedback before Judge normalization", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-review-legacy-freeform-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-review-legacy-freeform-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    const questions: string[] = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec") return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the plan using ISSUES, RECOMMENDATIONS, and READY_FOR_JUDGE.";
        }
        if (params.agent === "review" && calls.length === 4) {
          return "ISSUES:\nNo blocking issues.\nRECOMMENDATIONS:\nProceed after Judge normalizes.\nREADY_FOR_JUDGE: yes";
        }
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: Judge normalized the free-form review.";
        return "NEXT_AGENT: done\nTASK:\nStopped after Judge normalization.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async (question) => {
        questions.push(question);
        return "";
      }
    });

    expect(result).toBe("Stopped after Judge normalization.");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("Approved PLAN_ONLY output:");

    const content = await readFile(log.path, "utf8");
    expect(content).not.toContain("Runtime blocked Review approval");
    expect(content).not.toContain("Received legacy Review protocol fields");
  });

  it.each(["无", "没有阻塞问题", "no blocking findings", "no blockers"])(
    "allows Review no-blocker value %s",
    async (blockingFindings) => {
      const workspace = path.join("/private/tmp", `maspl-loop-review-no-blocker-value-${process.pid}-${blockingFindings}`);
      await mkdir(workspace, { recursive: true });
      const roles = parseRolesConfig(defaultRolesYaml);
      const log = await createSessionLog({
        workspace,
        goal: "test",
        runId: `loop-review-no-blocker-value-${blockingFindings}`
      });
      const calls: Array<{ agent: string; task: string }> = [];
      const questions: string[] = [];

      const backend: AgentBackend = {
        name: "fake",
        async runAgent(params: AgentRunParams) {
          calls.push({ agent: params.agent, task: params.task });
          if (params.agent === "orchestrator" && calls.length === 1) {
            return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
          }
          if (params.agent === "exec") return "Plan ready.";
          if (params.agent === "orchestrator" && calls.length === 3) {
            return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
          }
          if (params.agent === "review") return validReviewOutput(blockingFindings);
          if (params.agent === "orchestrator" && calls.length === 5) {
            return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
          }
          if (params.agent === "judge") return "SATISFIED\nReason: Review reported no blockers.";
          return "NEXT_AGENT: done\nTASK:\nStopped after accepted Review.";
        }
      };

      const result = await runOrchestration({
        backend,
        goal: "test",
        workspace,
        roles,
        log,
        askHuman: async (question) => {
          questions.push(question);
          return "";
        }
      });

      expect(result).toBe("Stopped after accepted Review.");
      expect(questions).toHaveLength(1);

      const content = await readFile(log.path, "utf8");
      expect(content).not.toContain("Runtime blocked Review approval");
    }
  );

  it("does not count Review CLARIFICATION_BLOCKED as a completed plan review", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-review-clarification-block-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-review-clarification-block-test" });
    const calls: Array<{ agent: string; task: string }> = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec") return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") {
          return "CLARIFICATION_BLOCKED\nQuestion: Which user segment should this optimize for?\nOptions:\n1. teachers\n2. parents\nDefault if blank: teachers";
        }
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge despite missing clarification.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: incorrectly ignored Review clarification.";
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: must remain blocked.";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after Review clarification block.";
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

    expect(result).toBe("Stopped after Review clarification block.");
    expect(calls.some(isExecExecuteApprovedPlanCall)).toBe(false);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("CLARIFICATION_BLOCKED");
    expect(content).toContain("Runtime blocked EXECUTE_APPROVED_PLAN");
  });

  it("blocks EXECUTE_APPROVED_PLAN when Judge normalizes Review risks as NOT_SATISFIED", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-judge-normalizes-review-risk-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-judge-normalizes-review-risk-test" });
    const calls: Array<{ agent: string; task: string }> = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec") return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") {
          return "I see a blocking risk: the plan never says how to validate the generated artifact path.";
        }
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") {
          return `NOT_SATISFIED
Reason: Review identified an unresolved validation risk.
Modification direction: Add artifact-path validation before execution.
Instruction to Orchestrator: Send the plan back to Exec in PLAN_ONLY mode with the validation requirement.`;
        }
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: incorrectly implement despite review findings.";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after Judge rejected the reviewed plan.";
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

    expect(result).toBe("Stopped after Judge rejected the reviewed plan.");
    expect(calls.some(isExecExecuteApprovedPlanCall)).toBe(false);

    const content = await readFile(log.path, "utf8");
    expect(content).not.toContain("Runtime blocked Review approval");
    expect(content).toContain("Runtime blocked EXECUTE_APPROVED_PLAN");
  });

  it("lets Judge request a more concrete Review when free-form Review is too vague", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-review-too-vague-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-review-too-vague-test" });
    const calls: Array<{ agent: string; task: string }> = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec") return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") return "Looks okay.";
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the vague review.";
        }
        if (params.agent === "judge") {
          return `NOT_SATISFIED
Reason: Review feedback is too vague to support a safe decision.
Modification direction: Ask Review for concrete risks and validation ideas.
Instruction to Orchestrator: Dispatch Review again with a more concrete review task.`;
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after Judge requested stronger review.";
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

    expect(result).toBe("Stopped after Judge requested stronger review.");

    const content = await readFile(log.path, "utf8");
    expect(content).not.toContain("Runtime blocked Review approval");
    expect(content).toContain("Review feedback is too vague");
  });

  it("blocks EXECUTE_APPROVED_PLAN when Judge returns SATISFIED without a reason", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-judge-protocol-block-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-judge-protocol-block-test" });
    const calls: Array<{ agent: string; task: string }> = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec") return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") return validReviewOutput();
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") return "SATISFIED";
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: incorrectly implement after weak judge.";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after judge protocol gate.";
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

    expect(result).toBe("Stopped after judge protocol gate.");
    expect(calls.some(isExecExecuteApprovedPlanCall)).toBe(false);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("Judge output did not satisfy the required protocol");
    expect(content).toContain("Missing fields: Reason");
  });

  it("reports incomplete NEED_HUMAN Judge output back to Orchestrator", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-judge-human-protocol-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-judge-human-protocol-test" });
    const calls: Array<{ agent: string; task: string }> = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec") return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") return validReviewOutput();
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") return "NEED_HUMAN\nReason: user preference decides scope.";
        return "NEXT_AGENT: done\nTASK:\nStopped after incomplete human request.";
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

    expect(result).toBe("Stopped after incomplete human request.");

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("Judge output did not satisfy the required protocol");
    expect(content).toContain("Missing fields: Question, Options, Default if blank, Instruction to Orchestrator");
  });

  it("reports incomplete NOT_SATISFIED Judge output back to Orchestrator", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-judge-not-satisfied-protocol-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({
      workspace,
      goal: "test",
      runId: "loop-judge-not-satisfied-protocol-test"
    });
    const calls: Array<{ agent: string; task: string }> = [];

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: propose the plan.";
        }
        if (params.agent === "exec") return "Plan ready.";
        if (params.agent === "orchestrator" && calls.length === 3) {
          return "NEXT_AGENT: review\nTASK:\nReview the PLAN_ONLY proposal.";
        }
        if (params.agent === "review") return validReviewOutput();
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") return "NOT_SATISFIED\nReason: plan lacks validation.";
        return "NEXT_AGENT: done\nTASK:\nStopped after incomplete not satisfied judgment.";
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

    expect(result).toBe("Stopped after incomplete not satisfied judgment.");

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("Judge output did not satisfy the required protocol");
    expect(content).toContain("Missing fields: Modification direction, Instruction to Orchestrator");
  });

  it("passes complete NEED_HUMAN Judge output through Orchestrator to askHuman", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-judge-human-positive-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-judge-human-positive-test" });
    const questions: string[] = [];
    let orchestratorCalls = 0;

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        if (params.agent === "orchestrator") {
          orchestratorCalls += 1;
        }
        if (params.agent === "orchestrator" && orchestratorCalls === 1) {
          return "NEXT_AGENT: judge\nTASK:\nJudge whether user preference is needed.";
        }
        if (params.agent === "judge") {
          return `NEED_HUMAN
Reason: target audience changes the output.
Question: Which audience should this optimize for?
Options:
1. Students - simpler language and examples.
2. Teachers - more assessment detail.
Default if blank: Students.
Instruction to Orchestrator: Ask the human before continuing.`;
        }
        if (params.agent === "orchestrator" && orchestratorCalls === 2) {
          return `NEXT_AGENT: human
TASK:
Question: Which audience should this optimize for?
Options:
1. Students - simpler language and examples.
2. Teachers - more assessment detail.
Default if blank: Students.`;
        }
        return "NEXT_AGENT: done\nTASK:\nDone.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async (question) => {
        questions.push(question);
        return "";
      },
      maxTurns: 4
    });

    expect(result).toBe("Done.");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("Students - simpler language");
    expect(questions[0]).toContain("Default if blank");
  });

  it("hands PLAN_ONLY clarification blocks back to Orchestrator for human choice", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-clarification-block-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-clarification-block-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    const questions: string[] = [];
    let clarificationQuestionAsked = false;

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nPLAN_ONLY: clarify target scope before planning.";
        }
        if (params.agent === "exec") {
          return `CLARIFICATION_BLOCKED
Question: Which target should this plan optimize for?
Options:
1. web
2. cli
Default if blank: cli`;
        }
        if (
          params.agent === "orchestrator" &&
          params.task.includes("CLARIFICATION_BLOCKED") &&
          !clarificationQuestionAsked
        ) {
          clarificationQuestionAsked = true;
          return "NEXT_AGENT: human\nTASK:\nClarification needed. Choose:\n1. web\n2. cli\nDefault if blank: cli";
        }
        return "NEXT_AGENT: done\nTASK:\nClarification handled.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async (question) => {
        questions.push(question);
        return "cli";
      }
    });

    expect(result).toBe("Clarification handled.");
    expect(questions[0]).toContain("Clarification needed");
    expect(calls.map((call) => call.agent)).toEqual(["orchestrator", "exec", "orchestrator", "orchestrator"]);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("CLARIFICATION_BLOCKED");
    expect(content).toContain("Exec Agent -> Orchestrator Agent");
  });

  it("hands permission blocked agent failures back to Orchestrator for human confirmation", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-permission-block-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-permission-block-test" });
    const calls: Array<{ agent: string; task: string }> = [];
    const questions: string[] = [];
    let permissionQuestionAsked = false;

    const backend: AgentBackend = {
      name: "fake",
      async runAgent(params: AgentRunParams) {
        calls.push({ agent: params.agent, task: params.task });
        if (params.agent === "orchestrator" && calls.length === 1) {
          return "NEXT_AGENT: exec\nTASK:\nWrite protected file.";
        }
        if (params.agent === "exec") {
          throw new Error("permission denied: write protected file requires approval");
        }
        if (params.agent === "orchestrator" && params.task.includes("PERMISSION_BLOCKED") && !permissionQuestionAsked) {
          permissionQuestionAsked = true;
          return "NEXT_AGENT: human\nTASK:\nPermission blocked. Choose:\n1. approve\n2. deny\n3. modify scope";
        }
        return "NEXT_AGENT: done\nTASK:\nPermission handled.";
      }
    };

    const result = await runOrchestration({
      backend,
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async (question) => {
        questions.push(question);
        return "approve";
      }
    });

    expect(result).toBe("Permission handled.");
    expect(questions[0]).toContain("Permission blocked");
    expect(calls.map((call) => call.agent)).toEqual(["orchestrator", "exec", "orchestrator", "orchestrator"]);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("PERMISSION_BLOCKED");
    expect(content).toContain("returned control to Orchestrator");
  });
});

function validReviewOutput(blockingFindings = "none"): string {
  return `PROBLEM_FRAMING:
The run should produce the smallest useful implementation that satisfies the goal.
SCOPE_REDUCTION:
Keep this slice limited to the approved plan and avoid unrelated work.
MUST_HAVE:
Implement the requested behavior and verify it.
NICE_TO_HAVE:
Additional polish can wait.
OUT_OF_SCOPE:
Unrelated refactors and optional integrations.
ASSUMPTIONS_OR_CLARIFICATIONS:
No blocking clarification needed for this test.
CHALLENGE_CASES:
Check an edge case that could falsify the plan.
VALIDATION_CASES:
Run the relevant automated or manual verification command.
BLOCKING_FINDINGS: ${blockingFindings}`;
}

function isExecExecuteApprovedPlanCall(call: { agent: string; task: string }): boolean {
  return call.agent === "exec" && /Task from Orchestrator:\s*\nEXECUTE_APPROVED_PLAN\b/.test(call.task);
}
