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
    expect(calls.some((call) => call.task.includes("EXECUTE_APPROVED_PLAN") && call.agent === "exec")).toBe(false);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("Runtime blocked EXECUTE_APPROVED_PLAN");
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
    expect(execTask).toContain("numbered options with impact");
    expect(execTask).toContain("Default if blank");
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
        return "";
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
    expect(calls.some((call) => call.agent === "exec" && call.task.includes("EXECUTE_APPROVED_PLAN"))).toBe(true);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("Judge returned SATISFIED");
    expect(questions[0]).toContain("Default if blank: Do not execute.");
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
        return "批准执行：允许 Exec Agent 按已通过的计划执行快速调研，并在 `/Users/admin/work/github/tmp` 下产出调研报告。";
      }
    });

    expect(result).toBe("All done.");
    expect(questions).toHaveLength(1);
    expect(calls.some((call) => call.agent === "exec" && call.task.includes("EXECUTE_APPROVED_PLAN"))).toBe(true);

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
        return "";
      }
    });

    expect(result).toBe("Stopped after human denied execution.");
    expect(questions).toHaveLength(1);
    expect(calls.some((call) => call.agent === "exec" && call.task.includes("EXECUTE_APPROVED_PLAN"))).toBe(false);

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
      expect(calls.some((call) => call.agent === "exec" && call.task.includes("EXECUTE_APPROVED_PLAN"))).toBe(false);

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
    expect(calls.some((call) => call.agent === "exec" && call.task.includes("EXECUTE_APPROVED_PLAN"))).toBe(false);
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
    expect(calls.some((call) => call.agent === "exec" && call.task.includes("EXECUTE_APPROVED_PLAN"))).toBe(false);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("Runtime blocked EXECUTE_APPROVED_PLAN");
  });

  it("blocks EXECUTE_APPROVED_PLAN when Review gives a generic no-blocking approval", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-review-protocol-block-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-review-protocol-block-test" });
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
        if (params.agent === "review") return "I agree. No blocking findings.";
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the incomplete review.";
        }
        if (params.agent === "judge") return "SATISFIED\nReason: review said no blocking findings.";
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: incorrectly implement after weak review.";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after review protocol gate.";
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

    expect(result).toBe("Stopped after review protocol gate.");
    expect(calls.some((call) => call.agent === "exec" && call.task.includes("EXECUTE_APPROVED_PLAN"))).toBe(false);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("Review output did not satisfy the required protocol");
    expect(content).toContain("Missing sections");
  });

  it("injects the required skeptic checklist into Review tasks", async () => {
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

    expect(reviewTask).toContain("Review protocol for this turn");
    expect(reviewTask).toContain("Do not merely agree with Exec");
    expect(reviewTask).toContain("PROBLEM_FRAMING");
    expect(reviewTask).toContain("CHALLENGE_CASES");
    expect(reviewTask).toContain("VALIDATION_CASES");
    expect(reviewTask).toContain("BLOCKING_FINDINGS");
  });

  it("blocks EXECUTE_APPROVED_PLAN when Review has blocking findings", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-review-blocking-findings-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-review-blocking-findings-test" });
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
        if (params.agent === "review") return validReviewOutput("Validation command is missing.");
        if (params.agent === "orchestrator" && calls.length === 5) {
          return "NEXT_AGENT: judge\nTASK:\nJudge the reviewed plan.";
        }
        if (params.agent === "judge") {
          return `SATISFIED
Reason: incorrect, review still has blocking findings.`;
        }
        if (params.agent === "orchestrator" && calls.length === 7) {
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: incorrectly implement despite review findings.";
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after review blocking findings gate.";
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

    expect(result).toBe("Stopped after review blocking findings gate.");
    expect(calls.some((call) => call.agent === "exec" && call.task.includes("EXECUTE_APPROVED_PLAN"))).toBe(false);

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("BLOCKING_FINDINGS must be exactly none");
  });

  it("blocks Review approval when challenge or validation cases are placeholders", async () => {
    const workspace = path.join("/private/tmp", `maspl-loop-review-weak-cases-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "loop-review-weak-cases-test" });
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
          return `PROBLEM_FRAMING:
Frame the problem.
SCOPE_REDUCTION:
Reduce the scope.
MUST_HAVE:
Must implement.
NICE_TO_HAVE:
Nice polish.
OUT_OF_SCOPE:
Other work.
ASSUMPTIONS_OR_CLARIFICATIONS:
No blocking clarification.
CHALLENGE_CASES:
ok
VALIDATION_CASES:
pass
BLOCKING_FINDINGS: none`;
        }
        return "NEXT_AGENT: done\nTASK:\nStopped after weak review gate.";
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

    expect(result).toBe("Stopped after weak review gate.");

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("Weak sections: CHALLENGE_CASES, VALIDATION_CASES");
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
    expect(calls.some((call) => call.agent === "exec" && call.task.includes("EXECUTE_APPROVED_PLAN"))).toBe(false);

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
          return "NEXT_AGENT: exec\nTASK:\nEXECUTE_APPROVED_PLAN: write protected file.";
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
