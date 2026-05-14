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
  planOutput: string | undefined;
  reviewedPlanVersion: number | undefined;
  judgedPlanVersion: number | undefined;
  humanApprovedPlanVersion: number | undefined;
  humanDecidedPlanVersion: number | undefined;
  reviewPassed: boolean;
  judgePassed: boolean;
  unresolvedRuntimePermissionBlock: boolean;
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
  workingDirectory?: string;
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
    planOutput: undefined,
    reviewedPlanVersion: undefined,
    judgedPlanVersion: undefined,
    humanApprovedPlanVersion: undefined,
    humanDecidedPlanVersion: undefined,
    reviewPassed: false,
    judgePassed: false,
    unresolvedRuntimePermissionBlock: false
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
      workingDirectory: effectiveWorkingDirectory(params),
      backends: formatAgentBackendMap(params)
    }
  });

  for (let step = 1; step <= maxTurns; step += 1) {
    const dispatch = await requestDispatch(params, outputs, step);

    if (dispatch.nextAgent === "done") {
      if (shouldRequestPlanExecutionApproval(planGate)) {
        const approvalOutput = await requestPlanExecutionApproval(params, planGate);
        outputs.push(approvalOutput);
        continue;
      }
      if (planGate.unresolvedRuntimePermissionBlock) {
        const gateBlock =
          "Runtime blocked finalization because a PERMISSION_BLOCKED execution fallback still needs Human confirmation.";
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
      if (shouldRequestPlanExecutionApproval(planGate)) {
        const approvalOutput = await requestPlanExecutionApproval(params, planGate);
        outputs.push(approvalOutput);
        planGate.unresolvedRuntimePermissionBlock = false;
        continue;
      }
      if (
        planGate.humanApprovedPlanVersion === planGate.planVersion &&
        isPlanExecutionApprovalLikeTask(dispatch.task)
      ) {
        outputs.push({
          agent: "Human",
          task: dispatch.task,
          output: "PLAN_EXECUTION_APPROVED: Runtime ignored duplicate Orchestrator execution-approval prompt because the current plan is already approved."
        });
        planGate.unresolvedRuntimePermissionBlock = false;
        continue;
      }
      if (isPlanExecutionApprovalLikeTask(dispatch.task) && planGate.hasPlan) {
        const approvalBlock = formatPlanExecutionApprovalNotReady(planGate);
        await params.log.appendTrace({
          agent: "Runtime",
          phase: "error",
          status: "failed",
          summary: approvalBlock,
          input: dispatch.task
        });
        outputs.push({
          agent: "Runtime",
          task: dispatch.task,
          output: approvalBlock
        });
        planGate.unresolvedRuntimePermissionBlock = false;
        continue;
      }
      const answer = await params.askHuman(dispatch.task);
      outputs.push({
        agent: "Human",
        task: dispatch.task,
        output: answer
      });
      planGate.unresolvedRuntimePermissionBlock = false;
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
        workingDirectory: effectiveWorkingDirectory(params),
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

    const previousOutputs = [...outputs];
    outputs.push({
      agent: targetName,
      task: dispatch.task,
      output
    });
    const gateUpdateMessage =
      validateExecPlanOnlyClarification(params.goal, previousOutputs, dispatch, output) ??
      validateExecExecutionFallback(dispatch, output) ??
      validateMetricEvidenceClaim(dispatch, output) ??
      updatePlanGate(planGate, dispatch.nextAgent, dispatch.task, output);
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
      if (gateUpdateMessage.includes("PERMISSION_BLOCKED")) {
        planGate.unresolvedRuntimePermissionBlock = true;
      }
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

    if (dispatch.nextAgent === "judge" && shouldRequestPlanExecutionApproval(planGate)) {
      const approvalOutput = await requestPlanExecutionApproval(params, planGate);
      outputs.push(approvalOutput);
    }
  }

  const orchestratorBackend = getAgentBackend(params, "orchestrator");
  const forcedFinal = await orchestratorBackend.runAgent({
    agent: "orchestrator",
    task: buildForcedFinalTask(outputs),
    taskInstruction: buildForcedFinalTask(outputs),
    goal: params.goal,
    workspace: params.workspace,
    workingDirectory: effectiveWorkingDirectory(params),
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

function effectiveWorkingDirectory(params: Pick<RunOrchestrationParams, "workingDirectory" | "workspace">): string {
  return params.workingDirectory ?? params.workspace;
}

function validatePlanGateDispatch(dispatch: Dispatch, planGate: PlanGateState): string | undefined {
  if (dispatch.nextAgent !== "exec") {
    return undefined;
  }

  if (isPlanOnlyTask(dispatch.task)) {
    return undefined;
  }

  if (!planGate.hasPlan) {
    if (isExecuteApprovedPlanTask(dispatch.task)) {
      return "Runtime blocked EXECUTE_APPROVED_PLAN. No PLAN_ONLY plan is active; run PLAN_ONLY, Review, Judge, and Human approval before executing an approved plan.";
    }
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
    return formatPlanGateNotReadyBlock(planGate);
  }

  if (planGate.humanApprovedPlanVersion !== planGate.planVersion) {
    return "Runtime blocked EXECUTE_APPROVED_PLAN. Human approval is required after Judge SATISFIED.";
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
    planGate.planOutput = output;
    planGate.reviewedPlanVersion = undefined;
    planGate.judgedPlanVersion = undefined;
    planGate.humanApprovedPlanVersion = undefined;
    planGate.humanDecidedPlanVersion = undefined;
    planGate.reviewPassed = false;
    planGate.judgePassed = false;
    planGate.unresolvedRuntimePermissionBlock = false;
    return undefined;
  }

  if (!planGate.hasPlan) {
    return undefined;
  }

  if (agent === "review") {
    const reviewCompleted = !containsHardBlockSignal(output);
    planGate.reviewPassed = reviewCompleted;
    planGate.reviewedPlanVersion = reviewCompleted ? planGate.planVersion : undefined;
    if (!reviewCompleted) {
      planGate.judgePassed = false;
      planGate.judgedPlanVersion = undefined;
      planGate.humanApprovedPlanVersion = undefined;
      planGate.humanDecidedPlanVersion = undefined;
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
      planGate.humanApprovedPlanVersion = undefined;
      planGate.humanDecidedPlanVersion = undefined;
      if (!validation.passed) {
        return formatJudgeValidationFailure(validation);
      }
    }
  }

  return undefined;
}

function validateExecPlanOnlyClarification(
  goal: string,
  previousOutputs: AgentOutput[],
  dispatch: Dispatch,
  output: string | undefined
): string | undefined {
  if (dispatch.nextAgent !== "exec" || !isPlanOnlyTask(dispatch.task)) {
    return undefined;
  }

  if (!requiresInitialClarification(goal, previousOutputs)) {
    return undefined;
  }

  if (/\bCLARIFICATION_BLOCKED\b/.test(output ?? "")) {
    return undefined;
  }

  return "CLARIFICATION_REQUIRED: Runtime blocked the PLAN_ONLY output because the initial goal is broad or underspecified. Exec must return CLARIFICATION_BLOCKED with a blocking question, numbered options with impact, and Default if blank before producing a concrete plan.";
}

function validateExecExecutionFallback(dispatch: Dispatch, output: string | undefined): string | undefined {
  if (dispatch.nextAgent !== "exec" || !isExecuteApprovedPlanTask(dispatch.task)) {
    return undefined;
  }

  const text = output ?? "";
  if (!hasExternalCapabilityFailure(text) || !hasUnapprovedFallbackSignal(text) || hasFallbackApprovalSignal(text)) {
    return undefined;
  }

  return `PERMISSION_BLOCKED
Blocked action: continuing EXECUTE_APPROVED_PLAN with an unapproved fallback after an external capability failure.
Reason: Exec output indicates an API/DNS/network/dependency failure and then switches to a fallback such as --no-api, local rules, cached/synthetic data, or reduced-scope execution. Runtime requires Human confirmation before changing the approved execution path.
Required approval: Ask the human whether to fix the environment and retry, approve the fallback, modify scope, or stop.`;
}

function validateMetricEvidenceClaim(dispatch: Dispatch, output: string | undefined): string | undefined {
  if (
    dispatch.nextAgent !== "review" &&
    dispatch.nextAgent !== "judge" &&
    !(dispatch.nextAgent === "exec" && isExecuteApprovedPlanTask(dispatch.task))
  ) {
    return undefined;
  }

  const text = output ?? "";
  if (
    !claimsMetricTarget(text) ||
    (!usesOfflineOrNoApiEvidence(text) && !usesUncomputedMetricEvidence(text)) ||
    explicitlyRejectsMetricEvidence(text)
  ) {
    return undefined;
  }

  return `VALIDATION_BLOCKED: Runtime rejected non-computed or non-production metric evidence for an acceptance threshold. An overall_metric/F1/eval target such as overall_metric >= 0.9 is valid only when it is actually computed by running the real external API against the full eval set. Analysis, estimates, predictions, expected scores, offline, dry-run, --no-api, local-rule, sampled, or fallback metrics may be reported as diagnostics, but they cannot justify completion, APPROVE, or SATISFIED. Re-dispatch Exec/Review/Judge to run the real API full-eval command and cite the produced metric artifact/log, or ask the human to approve a reduced/offline acceptance standard.`;
}

function claimsMetricTarget(text: string): boolean {
  return /overall[_ -]?metric|f1|F1|metric\s*[=:>=]|eval(?:uation)?\s*(?:score|metric)?|指标|评测/i.test(text) && /(?:0\.\d+|[1-9]\d(?:\.\d+)?%)/.test(text);
}

function usesOfflineOrNoApiEvidence(text: string): boolean {
  return /--no-api|no api|no-api|dry[- ]?run|offline|离线|不要调用真实\s*API|未调用真实\s*API|不调用真实\s*API|本地规则|local rules?|fallback|降级|sampled?|抽样|部分 eval|partial eval/i.test(
    text
  );
}

function usesUncomputedMetricEvidence(text: string): boolean {
  return /分析(?:认为|估计|判断)?|估算|预估|预测|预计|预期|推测|大概|约(?:为|等于)?|理论上|应(?:该|能|可)|可能(?:达到|为)|expected|estimate[sd]?|estimated|predict(?:ed|ion)?|projected|approximately|around|about|should\s+(?:reach|be|pass)|likely\s+(?:reach|be|pass)/i.test(
    text
  );
}

function explicitlyRejectsMetricEvidence(text: string): boolean {
  return /\b(?:REVISE|NOT_SATISFIED|NEED_HUMAN|PERMISSION_BLOCKED|CLARIFICATION_BLOCKED|VALIDATION_BLOCKED)\b|不(?:应|能|可|可以)?(?:批准|通过|接受|完成|视为达标)|不能(?:批准|通过|接受|完成|视为达标)|未(?:达标|满足)|不可接受|需要人工|需要真实\s*API|必须(?:运行|调用).{0,20}真实\s*API/i.test(
    text
  );
}

function hasExternalCapabilityFailure(text: string): boolean {
  return /api_error|api 探测失败|api.*失败|dns|无法解析|解析.*失败|connectionerror|httpsconnectionpool|network|网络|external api|dependency|依赖|credential|凭证|timeout|timed out/i.test(
    text
  );
}

function hasUnapprovedFallbackSignal(text: string): boolean {
  return /--no-api|fallback|fall back|本地规则|local rules?|deterministic local|cached data|cache|synthetic data|合成数据|降级|继续用|继续使用|reduced-scope|reduced scope/i.test(
    text
  );
}

function hasFallbackApprovalSignal(text: string): boolean {
  return /fallback (?:was )?(?:explicitly )?approved|approved fallback|human approved fallback|用户.*批准.*fallback|用户.*批准.*降级|已批准.*fallback|已批准.*降级|批准.*--no-api/i.test(
    text
  );
}

function requiresInitialClarification(goal: string, outputs: AgentOutput[]): boolean {
  if (outputs.some((output) => output.agent === "Human")) {
    return false;
  }

  if (outputs.some((output) => /\bCLARIFICATION_BLOCKED\b/.test(output.output ?? ""))) {
    return false;
  }

  const normalized = goal.trim();
  if (!normalized) {
    return true;
  }

  return hasBroadIntent(normalized) && isVeryShortGoal(normalized);
}

function hasBroadIntent(goal: string): boolean {
  return /调研|研究|分析|了解|探索|整理|规划|设计|做|写|research|investigate|analy[sz]e|explore|study|plan|design|write/i.test(
    goal
  );
}

function isVeryShortGoal(goal: string): boolean {
  const cjkChars = goal.match(/[\p{Script=Han}]/gu)?.length ?? 0;
  if (cjkChars > 0) {
    return cjkChars <= 10;
  }

  const words = goal.match(/[A-Za-z0-9]+/g)?.length ?? 0;
  return words > 0 && words <= 5;
}

async function requestPlanExecutionApproval(
  params: RunOrchestrationParams,
  planGate: PlanGateState
): Promise<AgentOutput> {
  const question = buildPlanExecutionApprovalQuestion(planGate.planVersion, planGate.planOutput);
  const answer = await params.askHuman(question);
  const decision = applyHumanPlanExecutionApproval(planGate, answer);

  return {
    agent: "Human",
    task: question,
    output: formatPlanExecutionApprovalOutput(decision, answer)
  };
}

function applyHumanPlanExecutionApproval(
  planGate: PlanGateState,
  answer: string | undefined
): PlanExecutionApprovalDecision {
  const decision = classifyPlanExecutionApproval(answer);
  const isPendingDecision = shouldRequestPlanExecutionApproval(planGate);
  if (isPendingDecision) {
    planGate.humanDecidedPlanVersion = planGate.planVersion;
  }
  if (decision === "approve" && isPendingDecision) {
    planGate.humanApprovedPlanVersion = planGate.planVersion;
  } else if (decision !== "approve" && planGate.humanApprovedPlanVersion === planGate.planVersion) {
    planGate.humanApprovedPlanVersion = undefined;
  }
  return decision;
}

type PlanExecutionApprovalDecision = "approve" | "deny" | "modify";

function shouldRequestPlanExecutionApproval(planGate: PlanGateState): boolean {
  return (
    planGate.judgePassed &&
    planGate.judgedPlanVersion === planGate.planVersion &&
    planGate.humanDecidedPlanVersion !== planGate.planVersion &&
    planGate.humanApprovedPlanVersion !== planGate.planVersion
  );
}

function isPlanExecutionApprovalLikeTask(task: string): boolean {
  return /执行批准|批准执行|进入执行|开始执行|确认.*执行|是否.*执行|execute approved plan|execution approval|approve execution|execute the approved plan|start execution/i.test(
    task
  );
}

function formatPlanGateNotReadyBlock(planGate: PlanGateState): string {
  return `Runtime blocked EXECUTE_APPROVED_PLAN. Exec mode opens only after the current PLAN_ONLY plan has been reviewed, Judge returns SATISFIED, and Human approves execution.
Gate status:
- planVersion: ${planGate.planVersion}
- reviewPassed: ${planGate.reviewPassed}
- reviewedPlanVersion: ${planGate.reviewedPlanVersion ?? "(none)"}
- judgePassed: ${planGate.judgePassed}
- judgedPlanVersion: ${planGate.judgedPlanVersion ?? "(none)"}
- humanApprovedPlanVersion: ${planGate.humanApprovedPlanVersion ?? "(none)"}`;
}

function formatPlanExecutionApprovalNotReady(planGate: PlanGateState): string {
  return `Runtime blocked Orchestrator-owned execution approval. Runtime owns the execution approval gate and will only ask the human after the current PLAN_ONLY has passed Review and Judge.
${formatPlanGateNotReadyBlock(planGate)}`;
}

function buildPlanExecutionApprovalQuestion(planVersion: number, planOutput: string | undefined): string {
  return `Judge returned SATISFIED for PLAN_ONLY version ${planVersion}. Review the approved plan below before choosing whether to execute it.

Approved PLAN_ONLY output:
${planOutput?.trim() || "(no PLAN_ONLY output recorded)"}

Confirm whether runtime should execute the approved plan.
1. Approve execution - continue with EXECUTE_APPROVED_PLAN.
2. Do not execute - stop after the approved plan.
3. Modify plan/scope - return to PLAN_ONLY with human feedback.
Default if blank: Approve execution.`;
}

function classifyPlanExecutionApproval(answer: string | undefined): PlanExecutionApprovalDecision {
  const normalized = answer?.trim().toLowerCase() ?? "";
  if (!normalized) return "approve";
  if (
    /^(2|deny|no|n|stop)\b/.test(normalized) ||
    normalized.includes("do not execute") ||
    /不批准|不同意|不允许|不要执行|不执行|停止|暂不执行|拒绝/.test(normalized)
  ) {
    return "deny";
  }
  if (
    /^(1|approve|approved|yes|y)\b/.test(normalized) ||
    normalized.includes("use default") ||
    normalized.includes("leave blank") ||
    normalized.includes("approve execution") ||
    /批准|同意|允许|可以执行|开始执行|继续执行|执行计划/.test(normalized)
  ) {
    return "approve";
  }
  return "modify";
}

function formatPlanExecutionApprovalOutput(
  decision: PlanExecutionApprovalDecision,
  answer: string | undefined
): string {
  const rawAnswer = answer?.trim();
  switch (decision) {
    case "approve":
      return "PLAN_EXECUTION_APPROVED: Human approved executing the Judge-satisfied PLAN_ONLY plan.";
    case "modify":
      return `PLAN_EXECUTION_MODIFY: Human requested plan or scope changes before execution.${rawAnswer ? `\nHuman feedback: ${rawAnswer}` : ""}`;
    case "deny":
      return `PLAN_EXECUTION_DENIED: Human did not approve execution. Stop after the approved plan unless the human later approves execution.${rawAnswer ? `\nHuman feedback: ${rawAnswer}` : ""}`;
  }
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
      workingDirectory: effectiveWorkingDirectory(params),
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

Current working directory:
${effectiveWorkingDirectory(params)}

MASPL workspace:
${params.workspace}

Agent outputs so far:
${formatAgentOutputs(outputs)}

Decide:
1. which agent should execute next;
2. what exact task that agent should execute.

Planning gate:
- For broad, ambiguous, exploratory, high-risk, or multi-step goals, first choose exec with a TASK that starts with PLAN_ONLY.
- A PLAN_ONLY output must go to review, then judge.
- Exec mode opens only after the current PLAN_ONLY plan has been reviewed, Judge returns SATISFIED, and Human approves execution.
- Do not choose exec with EXECUTE_APPROVED_PLAN until all three conditions are true.
- After Judge returns SATISFIED for PLAN_ONLY, do not choose NEXT_AGENT: human to ask
  your own execution-approval question. Runtime owns that approval gate, will show
  the approved PLAN_ONLY output, and will record the internal approval state.
- If Human does not approve execution after Judge SATISFIED, finish with the approved plan or return to PLAN_ONLY with the human feedback.
- If judge rejects the plan, send the requested plan improvements back to exec in PLAN_ONLY mode.
- For narrow deterministic goals, direct execution is allowed, but review should still define or run concrete validation.
- Dispatch Review with enough authority to run the validation that correctness requires:
  local scripts/tests, network/API checks, and full eval commands when they are in scope.
- Do not tell Review to skip real API/full eval validation when that validation is the
  acceptance standard. If access is unavailable, route the permission or environment
  problem to Human instead of downgrading Review.

Blocking gates:
- If an agent output contains CLARIFICATION_BLOCKED, do not guess or continue the blocked plan.
- Ask the human with NEXT_AGENT: human and provide concise options plus the blank-input default.
- If an agent output contains PERMISSION_BLOCKED, do not retry the same action.
- Ask the human with NEXT_AGENT: human and provide concise options: approve, deny, or modify scope/task.
- Human approval grants permission for the requested action scope, but does not prove
  network/API/dependency availability. If the approved action still fails, ask whether
  to change environment, retry, approve a fallback, or stop; do not silently downgrade.
- If Judge output starts with NEED_HUMAN, choose NEXT_AGENT: human.
- The human TASK must include Judge's Question, numbered Options, Default if blank, and option impact details.
- After human input, dispatch the appropriate agent with the approved scope, clarified decision, or safer alternative.

Return only:
NEXT_AGENT: exec | review | judge | human | done
TASK:
...

If NEXT_AGENT is done, TASK must explain:
- final output;
- where the output lives in the current working directory;
- how to use or verify it.`;
}

function buildAgentTask(
  params: RunOrchestrationParams,
  agent: AgentRoleName,
  task: string,
  outputs: AgentOutput[]
): string {
  const reviewProtocol = agent === "review" ? `\n${buildReviewGuidanceInstruction()}\n` : "";
  const judgeProtocol = agent === "judge" ? `\n${buildJudgeProtocolInstruction()}\n` : "";
  const execProtocol = agent === "exec" && isPlanOnlyTask(task) ? `\n${buildExecPlanOnlyInstruction(params.goal, outputs)}\n` : "";
  return `Goal:
${params.goal}

Current working directory:
${effectiveWorkingDirectory(params)}

MASPL workspace:
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

function buildExecPlanOnlyInstruction(goal: string, outputs: AgentOutput[]): string {
  const clarificationRequired = requiresInitialClarification(goal, outputs)
    ? `
Initial clarification gate:
- This user goal is too short/open-ended to plan safely without a human scope decision.
- Return CLARIFICATION_BLOCKED before producing a concrete plan.
- Ask for the intended audience/use case, desired output format, scope/depth, and success criteria.
`
    : "";
  return `Exec PLAN_ONLY protocol for this turn:
- Stay read-only and do not implement.
- Do not return PERMISSION_BLOCKED merely because future execution may need file writes,
  network access, external APIs, dependency installation, or credentials. List those as
  required capabilities/approvals in the plan instead.
- Return PERMISSION_BLOCKED in PLAN_ONLY only when the planning step itself is currently
  blocked by permissions, sandbox, missing credentials, or read-only access.
- Keep the plan concise and approval-ready: no more than 800 words or 80 lines.
- Include only the chosen direction, execution path, expected outputs/files, validation,
  assumptions, risks, and blocking open questions.
- Do not include broad background research, long explanations, exhaustive alternatives,
  or detailed content that belongs in EXECUTE_APPROVED_PLAN.
- Produce a plan only if the scope, correctness target, acceptance criteria, target environment,
  and validation approach are clear enough.
- If any missing decision materially changes scope, correctness, acceptance criteria,
  target environment, or validation, return CLARIFICATION_BLOCKED.
- CLARIFICATION_BLOCKED must include the blocking question, numbered options with impact,
  and Default if blank.${clarificationRequired}`;
}

function buildReviewGuidanceInstruction(): string {
  return `Review guidance for this turn:
- Do not merely agree with Exec.
- Review the goal, task, Exec output, assumptions, risks, scope, and validation path.
- You may write naturally; no fixed output sections are required by Runtime.
- State your strongest concerns, missing decisions, suggested scope reductions,
  concrete validation ideas, and whether the plan/result looks ready for Judge.
- You are expected to run concrete validation when correctness depends on it:
  local scripts/tests, network/API checks, artifact inspection, and full eval runs
  within the approved scope. Do not rely on Exec's claims when you can verify them.
- If the orchestrator task asks you to avoid a validation step that is required by
  the acceptance criteria, treat that as a conflict and report the required validation
  instead of approving weaker evidence.
- If human input is required before the plan can be correct, return CLARIFICATION_BLOCKED
  with the blocking question, options, and Default if blank.
- If review or validation is blocked by permissions, return PERMISSION_BLOCKED
  with the blocked action and why approval is needed.`;
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
Include final output, where the output lives in the current working directory, and how to use or verify it.

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

function containsHardBlockSignal(output: string | undefined): boolean {
  return /\b(?:CLARIFICATION_BLOCKED|PERMISSION_BLOCKED)\b/.test(output ?? "");
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
  const labeled = text.match(pattern)?.[1]?.trim();
  if (labeled !== undefined) {
    return labeled;
  }

  if (field === "Reason") {
    const inlineReason = text.match(
      /^\s*(?:SATISFIED|NOT_SATISFIED|NEED_HUMAN)\b\s+Reason:\s*([\s\S]*?)(?=^(${fieldPattern}):\s*|\s*$)/im
    )?.[1]?.trim();
    if (inlineReason !== undefined) {
      return inlineReason;
    }
  }

  return undefined;
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
