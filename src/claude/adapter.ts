import type { AgentBackend, AgentRunParams } from "../backend/types.js";
import { loadClaudeSdk, type ClaudeSdkModule } from "./sdk-loader.js";

export type ClaudeAgentRunParams = AgentRunParams & {
  sdk?: ClaudeSdkModule;
};

type ClaudeSessionState = {
  sessionIds: Map<AgentRunParams["agent"], string>;
  sessionOwners: Map<string, AgentRunParams["agent"]>;
};

export function createClaudeBackend(sdkOverride?: ClaudeSdkModule): AgentBackend {
  const state: ClaudeSessionState = {
    sessionIds: new Map(),
    sessionOwners: new Map()
  };
  let sdkPromise: Promise<ClaudeSdkModule> | undefined;

  async function getSdk(): Promise<ClaudeSdkModule> {
    sdkPromise ??= sdkOverride ? Promise.resolve(sdkOverride) : loadClaudeSdk();
    return sdkPromise;
  }

  return {
    name: "claude",
    async runAgent(params: AgentRunParams) {
      return runClaudeAgent({ ...params, sdk: sdkOverride ?? (await getSdk()) }, state);
    }
  };
}

export const claudeBackend: AgentBackend = createClaudeBackend();

async function runClaudeAgent(params: ClaudeAgentRunParams, state: ClaudeSessionState): Promise<string | undefined> {
  const sdk = params.sdk ?? (await loadClaudeSdk());
  const abortController = new AbortController();
  const timeoutMs = params.timeoutMs ?? params.roles.runtime.timeoutMs;
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  const role = params.roles[params.agent];
  const agentName = toAgentName(params.agent);

  try {
    const options = {
      cwd: params.workspace,
      maxTurns: params.maxTurns ?? params.roles.runtime.maxTurns,
      abortController,
      model: normalizeClaudeModel(role.model),
      permissionMode: permissionModeForAgent(params),
      allowedTools: allowedToolsForAgent(params),
      disallowedTools: params.roles.runtime.disallowedTools,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: role.prompt
      },
      resume: state.sessionIds.get(params.agent)
    };

    await params.log.appendEvent("Claude Agent Options", {
      agent: params.agent,
      cwd: options.cwd,
      maxTurns: options.maxTurns,
      model: options.model,
      permissionMode: options.permissionMode,
      allowedTools: options.allowedTools,
      resume: options.resume
    });

    await params.log.registerAgentSession({
      agent: params.agent,
      backend: "claude",
      sessionId: options.resume
    });

    let finalResult: string | undefined;
    for await (const message of sdk.query({
      prompt: buildPrompt(params),
      options
    })) {
      await captureSessionId(params, state, message);
      await appendClaudeTrace(params, message, agentName);
      const maybeResult = extractResult(message);
      if (maybeResult) {
        finalResult = maybeResult;
      }
    }

    return finalResult;
  } catch (error) {
    await params.log.appendTrace({
      agent: agentName,
      phase: "error",
      status: "failed",
      summary: `${agentName} failed in Claude backend.`,
      output: error instanceof Error ? error.message : String(error)
    });
    throw normalizeClaudeError(error);
  } finally {
    clearTimeout(timeout);
  }
}

async function captureSessionId(
  params: ClaudeAgentRunParams,
  state: ClaudeSessionState,
  message: unknown
): Promise<void> {
  if (!isRecord(message)) return;
  const sessionId = message.session_id;
  if (typeof sessionId === "string" && sessionId) {
    assertUniqueAgentSession(state.sessionOwners, sessionId, params.agent);
    state.sessionIds.set(params.agent, sessionId);
    await params.log.registerAgentSession({
      agent: params.agent,
      backend: "claude",
      sessionId
    });
  }
}

function assertUniqueAgentSession(
  owners: Map<string, AgentRunParams["agent"]>,
  sessionId: string,
  agent: AgentRunParams["agent"]
): void {
  const owner = owners.get(sessionId);
  if (owner && owner !== agent) {
    throw new Error(`Claude session id ${sessionId} is already owned by ${owner}; ${agent} cannot reuse it.`);
  }
  owners.set(sessionId, agent);
}

function buildPrompt(params: ClaudeAgentRunParams): string {
  return `Goal:
${params.goal}

Workspace:
${params.workspace}

Task:
${params.task}`;
}

async function appendClaudeTrace(params: ClaudeAgentRunParams, message: unknown, agentName: string): Promise<void> {
  if (!isRecord(message)) {
    await params.log.appendTrace({
      agent: "Claude SDK",
      phase: "progress",
      status: "running",
      summary: "Claude emitted a non-object message.",
      metadata: message
    });
    return;
  }

  if (message.type === "system") {
    await params.log.appendTrace({
      agent: "Claude SDK",
      phase: "progress",
      status: "running",
      summary: `Claude system event: ${String(message.subtype ?? "unknown")}`,
      metadata: summarizeSdkMessage(message)
    });
    return;
  }

  if (message.type === "result") {
    const isError = typeof message.subtype === "string" && message.subtype.startsWith("error");
    await params.log.appendTrace({
      agent: agentName,
      phase: isError ? "error" : "output",
      status: isError ? "failed" : "completed",
      summary: isError ? "Claude result reported an error." : "Claude result received.",
      output: message.result,
      metadata: summarizeSdkMessage(message)
    });
    return;
  }

  const nested = isRecord(message.message) ? message.message : undefined;
  if (!nested) {
    await params.log.appendTrace({
      agent: "Claude SDK",
      phase: "progress",
      status: "running",
      summary: `Claude message: ${String(message.type ?? "unknown")}`,
      metadata: summarizeSdkMessage(message)
    });
    return;
  }

  const content = Array.isArray(nested.content) ? nested.content : [];
  const text = extractTextContent(content);
  if (text) {
    await params.log.appendTrace({
      agent: agentName,
      phase: nested.role === "assistant" ? "output" : "input",
      status: "running",
      summary: `${agentName} ${nested.role === "assistant" ? "produced output" : "received input"}.`,
      input: nested.role === "assistant" ? undefined : text,
      output: nested.role === "assistant" ? text : undefined,
      metadata: {
        messageId: nested.id,
        stopReason: nested.stop_reason
      }
    });
  }
}

function summarizeSdkMessage(message: unknown): unknown {
  if (typeof message !== "object" || message === null) return message;
  const record = message as Record<string, unknown>;

  return {
    type: record.type,
    subtype: record.subtype,
    session_id: record.session_id,
    parent_tool_use_id: record.parent_tool_use_id,
    result: record.result,
    message: summarizeNestedMessage(record.message)
  };
}

function summarizeNestedMessage(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return {
    id: record.id,
    role: record.role,
    stop_reason: record.stop_reason,
    content: record.content
  };
}

function extractTextContent(content: unknown[]): string {
  return content
    .map((block) => {
      if (!isRecord(block) || block.type !== "text") return "";
      return typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function extractResult(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  if (!("result" in message)) return undefined;
  const result = (message as { result?: unknown }).result;
  return typeof result === "string" ? result : undefined;
}

function toAgentName(agent: ClaudeAgentRunParams["agent"]): string {
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

function defaultToolsForAgent(agent: ClaudeAgentRunParams["agent"]): string[] {
  if (agent === "orchestrator") {
    return [];
  }
  if (agent === "exec") {
    return ["Read", "Grep", "Glob", "Bash", "Edit", "MultiEdit", "Write"];
  }
  return ["Read", "Grep", "Glob"];
}

function allowedToolsForAgent(params: ClaudeAgentRunParams): string[] {
  const requested = isExecPlanOnly(params)
    ? ["Read", "Grep", "Glob", "Bash"]
    : roleFor(params).tools ?? defaultToolsForAgent(params.agent);
  const runtimeAllowed = new Set(params.roles.runtime.allowedTools);
  return requested.filter((tool) => runtimeAllowed.has(tool));
}

function permissionModeForAgent(params: ClaudeAgentRunParams): string | undefined {
  if (isExecPlanOnly(params)) {
    return "plan";
  }
  return roleFor(params).permissionMode ?? (params.agent === "exec" ? "acceptEdits" : "plan");
}

function roleFor(params: ClaudeAgentRunParams) {
  return params.roles[params.agent];
}

function isExecPlanOnly(params: ClaudeAgentRunParams): boolean {
  return params.agent === "exec" && /^\s*PLAN_ONLY\b/i.test(params.taskInstruction ?? params.task);
}

function normalizeClaudeModel(model: string | undefined): string | undefined {
  return model === "inherit" ? undefined : model;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeClaudeError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") {
    return new Error("Claude agent timed out.");
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
