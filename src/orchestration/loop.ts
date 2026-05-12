import type { AgentBackend, AgentRoleName } from "../backend/types.js";
import type { SessionLog } from "../logging/session-log.js";
import type { AskHuman } from "../tools/ask-human.js";
import type { BackendName, RolesConfig } from "../types.js";

type DispatchAgent = AgentRoleName | "human" | "done";

type Dispatch = {
  nextAgent: DispatchAgent;
  task: string;
};

type AgentOutput = {
  agent: string;
  task: string;
  output: string | undefined;
};

type PlanGateState = {
  hasPlan: boolean;
  planVersion: number;
  reviewedPlanVersion: number | undefined;
  judgedPlanVersion: number | undefined;
  reviewPassed: boolean;
  judgePassed: boolean;
};

const reviewProtocolSections = [
  "PROBLEM_FRAMING",
  "SCOPE_REDUCTION",
  "MUST_HAVE",
  "NICE_TO_HAVE",
  "OUT_OF_SCOPE",
  "ASSUMPTIONS_OR_CLARIFICATIONS",
  "CHALLENGE_CASES",
  "VALIDATION_CASES",
  "BLOCKING_FINDINGS"
] as const;

type ReviewProtocolSection = (typeof reviewProtocolSections)[number];

type ReviewValidation = {
  passed: boolean;
  missing: ReviewProtocolSection[];
  empty: ReviewProtocolSection[];
  weak: ReviewProtocolSection[];
  hasNoBlockingFindings: boolean;
};

type JudgeDecision = "SATISFIED" | "NOT_SATISFIED" | "NEED_HUMAN";

type JudgeValidation = {
  decision: JudgeDecision | undefined;
  passed: boolean;
  missing: string[];
  empty: string[];
};

export type RunOrchestrationParams = {
  backend?: AgentBackend;
  backends?: Partial<Record<BackendName, AgentBackend>>;
  backendOverride?: BackendName;
  goal: string;
  workspace: string;
  roles: RolesConfig;
  log: SessionLog;
  askHuman: AskHuman;
  maxTurns?: number;
  timeoutMs?: number;
};

export async function runOrchestration(params: RunOrchestrationParams): Promise<string | undefined> {
  const outputs: AgentOutput[] = [];
  const planGate: PlanGateState = {
    hasPlan: false,
    planVersion: 0,
    reviewedPlanVersion: undefined,
    judgedPlanVersion: undefined,
    reviewPassed: false,
    judgePassed: false
  };
  const maxTurns = params.maxTurns ?? params.roles.runtime.maxTurns;

  await params.log.appendTrace({
    agent: "Orchestrator Agent",
    phase: "input",
    status: "started",
    summary: "Runtime started backend-agnostic Orchestrator loop.",
    input: {
      goal: params.goal,
      workspace: params.workspace,
      backends: formatAgentBackendMap(params)
    }
  });

  for (let step = 1; step <= maxTurns; step += 1) {
    const dispatch = await requestDispatch(params, outputs, step);

    if (dispatch.nextAgent === "done") {
      const finalResult = dispatch.task;
      await params.log.appendTrace({
        agent: "Orchestrator Agent",
        phase: "output",
        status: "completed",
        summary: "Orchestrator Agent completed the run.",
        output: finalResult
      });
      await params.log.writeResult(finalResult ?? "");
      return finalResult;
    }

    if (dispatch.nextAgent === "human") {
      const answer = await params.askHuman(dispatch.task);
      outputs.push({
        agent: "Human",
        task: dispatch.task,
        output: answer
      });
      continue;
    }

    const gateBlock = validatePlanGateDispatch(dispatch, planGate);
    if (gateBlock) {
      await params.log.appendTrace({
        agent: "Runtime",
        phase: "error",
        status: "failed",
        summary: gateBlock,
        input: dispatch.task
      });
      outputs.push({
        agent: "Runtime",
        task: dispatch.task,
        output: gateBlock
      });
      continue;
    }

    const targetName = toAgentName(dispatch.nextAgent);
    await params.log.appendTrace({
      agent: "Orchestrator Agent",
      phase: "handoff",
      status: "started",
      summary: `Orchestrator selected ${targetName}.`,
      fromAgent: "Orchestrator Agent",
      toAgent: targetName,
      input: dispatch.task
    });

    let output: string | undefined;
    let handoffStatus: "completed" | "failed" = "completed";
    let handoffSummary = `${targetName} returned output to Orchestrator.`;
    const backend = getAgentBackend(params, dispatch.nextAgent);
    try {
      output = await backend.runAgent({
        agent: dispatch.nextAgent,
        task: buildAgentTask(params, dispatch.nextAgent, dispatch.task, outputs),
        taskInstruction: dispatch.task,
        goal: params.goal,
        workspace: params.workspace,
        roles: params.roles,
        log: params.log,
        maxTurns: params.maxTurns,
        timeoutMs: params.timeoutMs
      });
    } catch (error) {
      if (!isPermissionBlockedError(error)) {
        throw error;
      }
      output = formatPermissionBlockedOutput(targetName, dispatch.task, error);
      handoffStatus = "failed";
      handoffSummary = `${targetName} was blocked by permissions and returned control to Orchestrator.`;
    }

    outputs.push({
      agent: targetName,
      task: dispatch.task,
      output
    });
    const gateUpdateMessage = updatePlanGate(planGate, dispatch.nextAgent, dispatch.task, output);
    if (gateUpdateMessage) {
      await params.log.appendTrace({
        agent: "Runtime",
        phase: "error",
        status: "failed",
        summary: gateUpdateMessage,
        input: dispatch.task,
        output
      });
      outputs.push({
        agent: "Runtime",
        task: dispatch.task,
        output: gateUpdateMessage
      });
    }

    await params.log.appendTrace({
      agent: targetName,
      phase: "handoff",
      status: handoffStatus,
      summary: handoffSummary,
      fromAgent: targetName,
      toAgent: "Orchestrator Agent",
      input: dispatch.task,
      output
    });
  }

  const orchestratorBackend = getAgentBackend(params, "orchestrator");
  const forcedFinal = await orchestratorBackend.runAgent({
    agent: "orchestrator",
    task: buildForcedFinalTask(outputs),
    taskInstruction: buildForcedFinalTask(outputs),
    goal: params.goal,
    workspace: params.workspace,
    roles: params.roles,
    log: params.log,
    maxTurns: params.maxTurns,
    timeoutMs: params.timeoutMs
  });

  await params.log.appendTrace({
    agent: "Orchestrator Agent",
    phase: "output",
    status: "completed",
    summary: "Orchestrator Agent returned a forced final summary after budget exhaustion.",
    output: forcedFinal
  });
  await params.log.writeResult(forcedFinal ?? "");
  return forcedFinal;
}

function getAgentBackend(params: RunOrchestrationParams, agent: AgentRoleName): AgentBackend {
  if (params.backend) {
    return params.backend;
  }

  const backendName = params.backendOverride ?? params.roles[agent].backend ?? params.roles.runtime.backend;
  const backend = params.backends?.[backendName];
  if (!backend) {
    throw new Error(`Backend ${backendName} is not available for ${toAgentName(agent)}.`);
  }
  return backend;
}

function formatAgentBackendMap(params: RunOrchestrationParams): Record<AgentRoleName, string> | string {
  if (params.backend) {
    return params.backend.name;
  }

  return {
    orchestrator: params.backendOverride ?? params.roles.orchestrator.backend ?? params.roles.runtime.backend,
    exec: params.backendOverride ?? params.roles.exec.backend ?? params.roles.runtime.backend,
    review: params.backendOverride ?? params.roles.review.backend ?? params.roles.runtime.backend,
    judge: params.backendOverride ?? params.roles.judge.backend ?? params.roles.runtime.backend
  };
}

function validatePlanGateDispatch(dispatch: Dispatch, planGate: PlanGateState): string | undefined {
  if (dispatch.nextAgent !== "exec") {
    return undefined;
  }

  if (isPlanOnlyTask(dispatch.task)) {
    return undefined;
  }

  if (!planGate.hasPlan) {
    return undefined;
  }

  if (!isExecuteApprovedPlanTask(dispatch.task)) {
    return "Runtime blocked Exec execution because a PLAN_ONLY gate is active. Send PLAN_ONLY improvements, or wait for Review and Judge to pass before EXECUTE_APPROVED_PLAN.";
  }

  if (
    !planGate.reviewPassed ||
    !planGate.judgePassed ||
    planGate.reviewedPlanVersion !== planGate.planVersion ||
    planGate.judgedPlanVersion !== planGate.planVersion
  ) {
    return "Runtime blocked EXECUTE_APPROVED_PLAN. Exec mode opens only after Review reports no blocking findings and Judge returns SATISFIED for the PLAN_ONLY plan.";
  }

  return undefined;
}

function updatePlanGate(
  planGate: PlanGateState,
  agent: AgentRoleName,
  task: string,
  output: string | undefined
): string | undefined {
  if (agent === "exec" && isPlanOnlyTask(task)) {
    planGate.hasPlan = true;
    planGate.planVersion += 1;
    planGate.reviewedPlanVersion = undefined;
    planGate.judgedPlanVersion = undefined;
    planGate.reviewPassed = false;
    planGate.judgePassed = false;
    return undefined;
  }

  if (!planGate.hasPlan) {
    return undefined;
  }

  if (agent === "review") {
    const validation = validateReviewOutput(output);
    planGate.reviewPassed = validation.passed;
    planGate.reviewedPlanVersion = planGate.reviewPassed ? planGate.planVersion : undefined;
    if (!planGate.reviewPassed) {
      planGate.judgePassed = false;
      planGate.judgedPlanVersion = undefined;
      return formatReviewValidationFailure(validation);
    }
    return undefined;
  }

  if (agent === "judge") {
    const validation = validateJudgeOutput(output);
    planGate.judgePassed =
      planGate.reviewPassed &&
      planGate.reviewedPlanVersion === planGate.planVersion &&
      validation.decision === "SATISFIED" &&
      validation.passed;
    planGate.judgedPlanVersion = planGate.judgePassed ? planGate.planVersion : undefined;
    if (!planGate.judgePassed) {
      planGate.reviewPassed = false;
      planGate.reviewedPlanVersion = undefined;
      if (!validation.passed) {
        return formatJudgeValidationFailure(validation);
      }
    }
  }

  return undefined;
}

async function requestDispatch(
  params: RunOrchestrationParams,
  outputs: AgentOutput[],
  step: number
): Promise<Dispatch> {
  let task = buildDispatchTask(params, outputs, step);
  let lastOutput = "";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const backend = getAgentBackend(params, "orchestrator");
    const dispatchText = await backend.runAgent({
      agent: "orchestrator",
      task,
      taskInstruction: task,
      goal: params.goal,
      workspace: params.workspace,
      roles: params.roles,
      log: params.log,
      maxTurns: params.maxTurns,
      timeoutMs: params.timeoutMs
    });
    lastOutput = dispatchText ?? "";

    const dispatch = parseDispatch(dispatchText);
    if (dispatch) {
      return dispatch;
    }

    await params.log.appendTrace({
      agent: "Orchestrator Agent",
      phase: "error",
      status: "failed",
      summary: "Orchestrator dispatch output did not match the required protocol.",
      output: dispatchText
    });
    task = buildDispatchRetryTask(lastOutput);
  }

  throw new Error(`Orchestrator returned invalid dispatch format after retry. Output: ${lastOutput}`);
}

function buildDispatchTask(params: RunOrchestrationParams, outputs: AgentOutput[], step: number): string {
  return `Dispatch step ${step}.

Goal:
${params.goal}

Workspace:
${params.workspace}

Agent outputs so far:
${formatAgentOutputs(outputs)}

Decide:
1. which agent should execute next;
2. what exact task that agent should execute.

Planning gate:
- For broad, ambiguous, exploratory, high-risk, or multi-step goals, first choose exec with a TASK that starts with PLAN_ONLY.
- A PLAN_ONLY output must go to review, then judge.
- Exec mode opens only after Review reports no blocking findings and Judge returns SATISFIED for the PLAN_ONLY plan.
- Do not choose exec with EXECUTE_APPROVED_PLAN until both conditions are true.
- If judge rejects the plan, send the requested plan improvements back to exec in PLAN_ONLY mode.
- For narrow deterministic goals, direct execution is allowed, but review should still define or run concrete validation.

Blocking gates:
- If an agent output contains CLARIFICATION_BLOCKED, do not guess or continue the blocked plan.
- Ask the human with NEXT_AGENT: human and provide concise options plus the blank-input default.
- If an agent output contains PERMISSION_BLOCKED, do not retry the same action.
- Ask the human with NEXT_AGENT: human and provide concise options: approve, deny, or modify scope/task.
- If Judge output starts with NEED_HUMAN, choose NEXT_AGENT: human.
- The human TASK must include Judge's Question, numbered Options, Default if blank, and option impact details.
- After human input, dispatch the appropriate agent with the approved scope, clarified decision, or safer alternative.

Return only:
NEXT_AGENT: exec | review | judge | human | done
TASK:
...

If NEXT_AGENT is done, TASK must explain:
- final output;
- where the output lives in the workspace;
- how to use or verify it.`;
}

function buildAgentTask(
  params: RunOrchestrationParams,
  agent: AgentRoleName,
  task: string,
  outputs: AgentOutput[]
): string {
  const reviewProtocol = agent === "review" ? `\n${buildReviewProtocolInstruction()}\n` : "";
  const judgeProtocol = agent === "judge" ? `\n${buildJudgeProtocolInstruction()}\n` : "";
  const execProtocol = agent === "exec" && isPlanOnlyTask(task) ? `\n${buildExecPlanOnlyInstruction()}\n` : "";
  return `Goal:
${params.goal}

Workspace:
${params.workspace}

Task from Orchestrator:
${task}

Agent outputs so far:
${formatAgentOutputs(outputs)}
${execProtocol}
${reviewProtocol}
${judgeProtocol}

Follow your role prompt and return your result to Orchestrator.`;
}

function buildExecPlanOnlyInstruction(): string {
  return `Exec PLAN_ONLY protocol for this turn:
- Stay read-only and do not implement.
- Produce a plan only if the scope, correctness target, acceptance criteria, target environment,
  and validation approach are clear enough.
- If any missing decision materially changes scope, correctness, acceptance criteria,
  target environment, or validation, return CLARIFICATION_BLOCKED.
- CLARIFICATION_BLOCKED must include the blocking question, numbered options with impact,
  and Default if blank.`;
}

function buildReviewProtocolInstruction(): string {
  return `Review protocol for this turn:
- Do not merely agree with Exec.
- Clarify the user problem, reduce scope, separate must-have/nice-to-have/out-of-scope work,
  challenge the plan/result, and provide concrete validation or test cases.
- Return exactly these sections with non-empty values:
  PROBLEM_FRAMING:
  SCOPE_REDUCTION:
  MUST_HAVE:
  NICE_TO_HAVE:
  OUT_OF_SCOPE:
  ASSUMPTIONS_OR_CLARIFICATIONS:
  CHALLENGE_CASES:
  VALIDATION_CASES:
  BLOCKING_FINDINGS: none | <blocking findings>
- If any required section cannot be completed, return REVIEW_INCOMPLETE and explain what is missing.
- BLOCKING_FINDINGS may be "none" only after challenge and validation cases are concrete.`;
}

function buildJudgeProtocolInstruction(): string {
  return `Judge protocol for this turn:
- Return exactly one decision: SATISFIED, NOT_SATISFIED, or NEED_HUMAN.
- SATISFIED must include a non-empty Reason.
- NOT_SATISFIED must include non-empty Reason, Modification direction, and Instruction to Orchestrator.
- NEED_HUMAN must include non-empty Reason, Question, Options with numbered choices and impacts,
  Default if blank, and Instruction to Orchestrator.
- Do not return a bare decision without the required fields.`;
}

function buildForcedFinalTask(outputs: AgentOutput[]): string {
  return `The dispatch budget is exhausted. Summarize the current state for the user.
Include final output, where the output lives in the workspace, and how to use or verify it.

Agent outputs:
${formatAgentOutputs(outputs)}`;
}

function buildDispatchRetryTask(invalidOutput: string): string {
  return `Your previous dispatch did not match the required protocol.

Previous output:
${invalidOutput || "(empty)"}

Return only this exact format:
NEXT_AGENT: exec | review | judge | human | done
TASK:
...`;
}

function parseDispatch(value: string | undefined): Dispatch | undefined {
  const text = value ?? "";
  const agentMatch = text.match(/NEXT_AGENT\s*:\s*(exec|review|judge|human|done)/i);
  const taskMatch = text.match(/TASK\s*:\s*([\s\S]*)/i);
  if (!agentMatch || !taskMatch) {
    return undefined;
  }

  return {
    nextAgent: agentMatch[1].toLowerCase() as DispatchAgent,
    task: taskMatch?.[1]?.trim() || text.trim()
  };
}

function isPlanOnlyTask(task: string): boolean {
  return /^\s*PLAN_ONLY\b/i.test(task);
}

function isExecuteApprovedPlanTask(task: string): boolean {
  return /^\s*EXECUTE_APPROVED_PLAN\b/i.test(task);
}

function validateReviewOutput(output: string | undefined): ReviewValidation {
  const text = output ?? "";
  const sections = new Map<ReviewProtocolSection, string>();
  for (const section of reviewProtocolSections) {
    const value = extractReviewSection(text, section);
    if (value !== undefined) {
      sections.set(section, value);
    }
  }

  const missing = reviewProtocolSections.filter((section) => !sections.has(section));
  const empty = reviewProtocolSections.filter((section) => {
    const value = sections.get(section);
    return value !== undefined && value.trim().length === 0;
  });
  const weak = reviewProtocolSections.filter((section) => {
    if (section !== "CHALLENGE_CASES" && section !== "VALIDATION_CASES") {
      return false;
    }
    return isWeakReviewSectionValue(sections.get(section));
  });
  const blockingFindings = sections.get("BLOCKING_FINDINGS")?.trim() ?? "";
  const hasNoBlockingFindings = /^none\b/i.test(blockingFindings);

  return {
    passed: missing.length === 0 && empty.length === 0 && weak.length === 0 && hasNoBlockingFindings,
    missing,
    empty,
    weak,
    hasNoBlockingFindings
  };
}

function isWeakReviewSectionValue(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.length < 20) return true;
  return /^(ok|okay|none|n\/a|na|pass|passed|looks good|no issues)\.?$/i.test(normalized);
}

function extractReviewSection(text: string, section: ReviewProtocolSection): string | undefined {
  const sectionPattern = reviewProtocolSections.map(escapeRegExp).join("|");
  const pattern = new RegExp(`^${escapeRegExp(section)}:\\s*([\\s\\S]*?)(?=^(${sectionPattern}):\\s*|\\s*$)`, "im");
  return text.match(pattern)?.[1]?.trim();
}

function formatReviewValidationFailure(validation: ReviewValidation): string {
  const parts = ["Runtime blocked Review approval because Review output did not satisfy the required protocol."];
  if (validation.missing.length > 0) {
    parts.push(`Missing sections: ${validation.missing.join(", ")}.`);
  }
  if (validation.empty.length > 0) {
    parts.push(`Empty sections: ${validation.empty.join(", ")}.`);
  }
  if (validation.weak.length > 0) {
    parts.push(`Weak sections: ${validation.weak.join(", ")} must contain concrete cases, not placeholders.`);
  }
  if (!validation.hasNoBlockingFindings) {
    parts.push("BLOCKING_FINDINGS must be exactly none before Exec can enter EXECUTE_APPROVED_PLAN.");
  }
  return parts.join(" ");
}

function validateJudgeOutput(output: string | undefined): JudgeValidation {
  const text = output ?? "";
  const decision = parseJudgeDecision(text);
  const requiredFields = requiredJudgeFields(decision);
  const missing = requiredFields.filter((field) => extractLabeledField(text, field) === undefined);
  const empty = requiredFields.filter((field) => {
    const value = extractLabeledField(text, field);
    return value !== undefined && value.trim().length === 0;
  });

  return {
    decision,
    passed: decision !== undefined && missing.length === 0 && empty.length === 0,
    missing,
    empty
  };
}

function parseJudgeDecision(text: string): JudgeDecision | undefined {
  const match = text.match(/^\s*(SATISFIED|NOT_SATISFIED|NEED_HUMAN)\b/i);
  return match?.[1]?.toUpperCase() as JudgeDecision | undefined;
}

function requiredJudgeFields(decision: JudgeDecision | undefined): string[] {
  switch (decision) {
    case "SATISFIED":
      return ["Reason"];
    case "NOT_SATISFIED":
      return ["Reason", "Modification direction", "Instruction to Orchestrator"];
    case "NEED_HUMAN":
      return ["Reason", "Question", "Options", "Default if blank", "Instruction to Orchestrator"];
    default:
      return ["Decision"];
  }
}

function extractLabeledField(text: string, field: string): string | undefined {
  const fieldPattern = [
    "Reason",
    "Modification direction",
    "Instruction to Orchestrator",
    "Question",
    "Options",
    "Default if blank"
  ]
    .map(escapeRegExp)
    .join("|");
  const pattern = new RegExp(`^${escapeRegExp(field)}:\\s*([\\s\\S]*?)(?=^(${fieldPattern}):\\s*|\\s*$)`, "im");
  return text.match(pattern)?.[1]?.trim();
}

function formatJudgeValidationFailure(validation: JudgeValidation): string {
  const parts = ["Runtime blocked Judge approval because Judge output did not satisfy the required protocol."];
  if (!validation.decision) {
    parts.push("Missing decision: SATISFIED, NOT_SATISFIED, or NEED_HUMAN.");
  }
  if (validation.missing.length > 0) {
    parts.push(`Missing fields: ${validation.missing.join(", ")}.`);
  }
  if (validation.empty.length > 0) {
    parts.push(`Empty fields: ${validation.empty.join(", ")}.`);
  }
  return parts.join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPermissionBlockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(permission|approval|denied|not allowed|disallowed|forbidden|sandbox|read-only|readonly|operation not permitted|eacces|eperm)\b/i.test(
    message
  );
}

function formatPermissionBlockedOutput(agentName: string, task: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `PERMISSION_BLOCKED
Agent: ${agentName}
Task:
${task}

Reason:
${message}

Required handoff:
Return control to Orchestrator. Orchestrator must ask the human to approve, deny, or modify the blocked action before retrying.`;
}

function toAgentName(agent: AgentRoleName): string {
  switch (agent) {
    case "orchestrator":
      return "Orchestrator Agent";
    case "exec":
      return "Exec Agent";
    case "review":
      return "Review Agent";
    case "judge":
      return "Judge Agent";
  }
}

function formatAgentOutputs(outputs: AgentOutput[]): string {
  if (outputs.length === 0) {
    return "(none)";
  }

  return outputs
    .map(
      (entry, index) => `## ${index + 1}. ${entry.agent}
Task:
${entry.task}

Output:
${entry.output ?? "(no output)"}`
    )
    .join("\n\n");
}
