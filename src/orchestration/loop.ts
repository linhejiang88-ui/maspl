import type { AgentBackend, AgentRoleName } from "../backend/types.js";
import type { SessionLog } from "../logging/session-log.js";
import type { AskHuman } from "../tools/ask-human.js";
import type { RolesConfig } from "../types.js";

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

export type RunOrchestrationParams = {
  backend: AgentBackend;
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
  const maxTurns = params.maxTurns ?? params.roles.runtime.maxTurns;

  await params.log.appendTrace({
    agent: "Orchestrator Agent",
    phase: "input",
    status: "started",
    summary: "Runtime started backend-agnostic Orchestrator loop.",
    input: {
      goal: params.goal,
      workspace: params.workspace,
      backend: params.backend.name
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

    const output = await params.backend.runAgent({
      agent: dispatch.nextAgent,
      task: buildAgentTask(params, dispatch.nextAgent, dispatch.task, outputs),
      goal: params.goal,
      workspace: params.workspace,
      roles: params.roles,
      log: params.log,
      maxTurns: params.maxTurns,
      timeoutMs: params.timeoutMs
    });

    outputs.push({
      agent: targetName,
      task: dispatch.task,
      output
    });

    await params.log.appendTrace({
      agent: targetName,
      phase: "handoff",
      status: "completed",
      summary: `${targetName} returned output to Orchestrator.`,
      fromAgent: targetName,
      toAgent: "Orchestrator Agent",
      input: dispatch.task,
      output
    });
  }

  const forcedFinal = await params.backend.runAgent({
    agent: "orchestrator",
    task: buildForcedFinalTask(outputs),
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

async function requestDispatch(
  params: RunOrchestrationParams,
  outputs: AgentOutput[],
  step: number
): Promise<Dispatch> {
  let task = buildDispatchTask(params, outputs, step);
  let lastOutput = "";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const dispatchText = await params.backend.runAgent({
      agent: "orchestrator",
      task,
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
  return `Goal:
${params.goal}

Workspace:
${params.workspace}

Task from Orchestrator:
${task}

Agent outputs so far:
${formatAgentOutputs(outputs)}

Follow your role prompt and return your result to Orchestrator.`;
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
