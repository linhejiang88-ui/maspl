import type { AgentBackend, AgentRunParams } from "../backend/types.js";
import { loadCodexSdk, type CodexSdkModule } from "./sdk-loader.js";

export type CodexAgentRunParams = AgentRunParams & {
  sdk?: CodexSdkModule;
};

type CodexThread = {
  id: string | null;
  runStreamed(
    input: string,
    turnOptions?: { signal?: AbortSignal; outputSchema?: unknown }
  ): Promise<{ events: AsyncIterable<unknown> }>;
};

type CodexThreadState = {
  thread: CodexThread;
  sandboxMode: "read-only" | "workspace-write";
  networkAccessEnabled: boolean;
};

export function createCodexBackend(sdkOverride?: CodexSdkModule): AgentBackend {
  let sdkPromise: Promise<CodexSdkModule> | undefined;
  let codex: InstanceType<CodexSdkModule["Codex"]> | undefined;
  const threads = new Map<AgentRunParams["agent"], CodexThreadState>();

  async function getSdk(): Promise<CodexSdkModule> {
    sdkPromise ??= sdkOverride ? Promise.resolve(sdkOverride) : loadCodexSdk();
    return sdkPromise;
  }

  async function getThread(params: CodexAgentRunParams): Promise<CodexThread> {
    const sandboxMode = sandboxForAgent(params);
    const existing = threads.get(params.agent);
    const networkAccessEnabled = networkAccessForAgent(params);
    if (existing) {
      if (existing.sandboxMode === sandboxMode && existing.networkAccessEnabled === networkAccessEnabled) {
        return existing.thread;
      }

      if (existing.thread.id && codex?.resumeThread) {
        const resumed = codex.resumeThread(existing.thread.id, threadOptionsForAgent(params, sandboxMode));
        threads.set(params.agent, { thread: resumed, sandboxMode, networkAccessEnabled });
        return resumed;
      }

      return existing.thread;
    }

    const sdk = params.sdk ?? (await getSdk());
    codex ??= new sdk.Codex();
    const thread = codex.startThread(threadOptionsForAgent(params, sandboxMode));
    threads.set(params.agent, { thread, sandboxMode, networkAccessEnabled });
    return thread;
  }

  return {
    name: "codex",
    async runAgent(params: AgentRunParams) {
      return runCodexAgent({ ...params, sdk: sdkOverride }, getThread);
    }
  };
}

export const codexBackend: AgentBackend = createCodexBackend();

async function runCodexAgent(
  params: CodexAgentRunParams,
  getThread: (params: CodexAgentRunParams) => Promise<CodexThread>
): Promise<string | undefined> {
  const abortController = new AbortController();
  const timeoutMs = params.timeoutMs ?? params.roles.runtime.timeoutMs;
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  const agentName = toAgentName(params.agent);
  const maxTurns = effectiveMaxTurns(params);

  try {
    await params.log.appendEvent("Codex Agent Options", {
      agent: params.agent,
      workingDirectory: params.workingDirectory,
      workspace: params.workspace,
      skipGitRepoCheck: true,
      sandboxMode: sandboxForAgent(params),
      approvalPolicy: "on-request",
      networkAccessEnabled: networkAccessForAgent(params),
      model: normalizeModel(roleFor(params).model),
      maxTurns
    });

    const thread = await getThread(params);
    await params.log.registerAgentSession({
      agent: params.agent,
      backend: "codex",
      sessionId: thread.id
    });

    let finalResult: string | undefined;
    let startedTurns = 0;
    const result = await thread.runStreamed(buildPrompt(params), {
      signal: abortController.signal
    });

    for await (const event of result.events) {
      await appendCodexTrace(params, event, agentName);
      const maybeFinal = extractAgentMessage(event);
      if (maybeFinal) {
        finalResult = maybeFinal;
      }
      if (isTurnStarted(event)) {
        startedTurns += 1;
        if (startedTurns > maxTurns) {
          abortController.abort();
          await params.log.appendTrace({
            agent: agentName,
            phase: "error",
            status: "failed",
            summary: `${agentName} reached the Codex turn budget.`,
            output: `Codex agent reached maxTurns (${maxTurns}).`
          });
          throw new Error(`Codex agent reached maxTurns (${maxTurns}).`);
        }
      }
    }

    return finalResult;
  } catch (error) {
    await params.log.appendTrace({
      agent: agentName,
      phase: "error",
      status: "failed",
      summary: `${agentName} failed in Codex backend.`,
      output: error instanceof Error ? error.message : String(error)
    });
    throw normalizeCodexError(error);
  } finally {
    clearTimeout(timeout);
  }
}

function buildPrompt(params: CodexAgentRunParams): string {
  return `${roleFor(params).prompt}

Goal:
${params.goal}

Current working directory:
${params.workingDirectory}

MASPL workspace:
${params.workspace}

Task:
${params.task}`;
}

async function appendCodexTrace(params: CodexAgentRunParams, event: unknown, agentName: string): Promise<void> {
  if (!isRecord(event)) {
    await params.log.appendTrace({
      agent: "Codex SDK",
      phase: "progress",
      status: "running",
      summary: "Codex emitted a non-object event.",
      metadata: event
    });
    return;
  }

  if (event.type === "thread.started") {
    await params.log.appendTrace({
      agent: agentName,
      phase: "progress",
      status: "started",
      summary: "Codex thread started.",
      metadata: event
    });
    return;
  }

  if (event.type === "turn.started") {
    await params.log.appendTrace({
      agent: agentName,
      phase: "progress",
      status: "running",
      summary: "Codex turn started.",
      metadata: event
    });
    return;
  }

  if (event.type === "turn.completed") {
    await params.log.appendTrace({
      agent: agentName,
      phase: "progress",
      status: "completed",
      summary: "Codex turn completed.",
      metadata: event
    });
    return;
  }

  if (event.type === "turn.failed" || event.type === "error") {
    await params.log.appendTrace({
      agent: agentName,
      phase: "error",
      status: "failed",
      summary: "Codex turn failed.",
      output: event
    });
    return;
  }

  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") {
    await params.log.appendTrace({
      agent: "Codex SDK",
      phase: "progress",
      status: "running",
      summary: `Codex emitted ${String(event.type)}.`,
      metadata: event
    });
    return;
  }

  const item = isRecord(event.item) ? event.item : undefined;
  const itemStatus = event.type === "item.completed" ? "completed" : "running";
  if (!item) return;

  switch (item.type) {
    case "agent_message":
      await params.log.appendTrace({
        agent: agentName,
        phase: event.type === "item.completed" ? "output" : "progress",
        status: itemStatus,
        summary: `${agentName} produced a message.`,
        output: item.text,
        metadata: { itemId: item.id }
      });
      return;
    case "command_execution":
      await params.log.appendTrace({
        agent: agentName,
        phase: "progress",
        status: normalizeItemStatus(item.status, itemStatus),
        summary: `Command ${String(item.status ?? itemStatus)}: ${String(item.command ?? "")}`,
        input: item.command,
        output: item.aggregated_output,
        metadata: {
          itemId: item.id,
          exitCode: item.exit_code
        }
      });
      return;
    case "file_change":
      await params.log.appendTrace({
        agent: agentName,
        phase: "progress",
        status: normalizeItemStatus(item.status, itemStatus),
        summary: "Workspace file changes reported.",
        output: item.changes,
        metadata: {
          itemId: item.id,
          status: item.status
        }
      });
      return;
    case "mcp_tool_call":
      await params.log.appendTrace({
        agent: agentName,
        phase: "handoff",
        status: normalizeItemStatus(item.status, itemStatus),
        summary: `MCP tool call: ${String(item.server ?? "unknown")}.${String(item.tool ?? "unknown")}`,
        fromAgent: agentName,
        toAgent: `MCP:${String(item.server ?? "unknown")}`,
        input: item.arguments,
        output: item.result ?? item.error,
        metadata: { itemId: item.id }
      });
      return;
    default:
      await params.log.appendTrace({
        agent: agentName,
        phase: "progress",
        status: itemStatus,
        summary: `Codex item update: ${String(item.type)}`,
        metadata: item
      });
  }
}

function roleFor(params: CodexAgentRunParams) {
  return params.roles[params.agent];
}

function effectiveMaxTurns(params: CodexAgentRunParams): number {
  return roleFor(params).maxTurns ?? params.maxTurns ?? params.roles.runtime.maxTurns;
}

function threadOptionsForAgent(
  params: CodexAgentRunParams,
  sandboxMode: "read-only" | "workspace-write" = sandboxForAgent(params)
): Record<string, unknown> {
  return {
    workingDirectory: params.workingDirectory,
    skipGitRepoCheck: true,
    sandboxMode,
    approvalPolicy: "on-request",
    model: normalizeModel(roleFor(params).model),
    networkAccessEnabled: networkAccessForAgent(params)
  };
}

function sandboxForAgent(params: Pick<CodexAgentRunParams, "agent" | "task" | "taskInstruction">): "read-only" | "workspace-write" {
  if (isExecPlanOnly(params)) {
    return "read-only";
  }
  return params.agent === "exec" || params.agent === "review" ? "workspace-write" : "read-only";
}

function networkAccessForAgent(params: Pick<CodexAgentRunParams, "agent" | "task" | "taskInstruction">): boolean {
  if (params.agent === "review") {
    return true;
  }
  return params.agent === "exec" && !isExecPlanOnly(params);
}

function isExecPlanOnly(params: Pick<CodexAgentRunParams, "agent" | "task" | "taskInstruction">): boolean {
  return params.agent === "exec" && /^\s*PLAN_ONLY\b/i.test(params.taskInstruction ?? params.task);
}

function toAgentName(agent: CodexAgentRunParams["agent"]): string {
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

function normalizeItemStatus(status: unknown, fallback: "running" | "completed"): "running" | "completed" | "failed" {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return fallback;
}

function normalizeModel(model: string | undefined): string | undefined {
  if (!model || model === "inherit" || model === "sonnet") {
    return undefined;
  }
  return model;
}

function extractAgentMessage(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== "item.completed") {
    return undefined;
  }

  const item = event.item;
  if (!isRecord(item) || item.type !== "agent_message") {
    return undefined;
  }

  return typeof item.text === "string" ? item.text : undefined;
}

function isTurnStarted(event: unknown): boolean {
  return isRecord(event) && event.type === "turn.started";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeCodexError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") {
    return new Error("Codex agent timed out.");
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
