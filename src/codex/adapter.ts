import type { AgentBackend, AgentBackendRunParams } from "../backend/types.js";
import { loadCodexSdk, type CodexSdkModule } from "./sdk-loader.js";

export type CodexRunParams = AgentBackendRunParams & {
  sdk?: CodexSdkModule;
};

export const codexBackend: AgentBackend = {
  name: "codex",
  run(params: AgentBackendRunParams) {
    return runCodexSession(params);
  }
};

export async function runCodexSession(params: CodexRunParams): Promise<string | undefined> {
  const sdk = params.sdk ?? (await loadCodexSdk());
  const abortController = new AbortController();
  const timeoutMs = params.timeoutMs ?? params.roles.runtime.timeoutMs;
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    await params.log.appendEvent("Codex Backend Notice", {
      reviewer:
        "Codex SDK 0.130.0 public API exposes thread runs and MCP call events, but not native subagent registration. The reviewer prompt is included as an explicit review discipline for the Main Agent.",
      ask_human:
        "Codex SDK 0.130.0 public API does not expose in-process tool registration. ask_human is available in the Claude backend; Codex backend should ask the user in final output if blocked."
    });

    const codex = new sdk.Codex();
    const thread = codex.startThread({
      workingDirectory: params.workspace,
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      model: normalizeModel(params.roles.main.model),
      networkAccessEnabled: false
    });

    await params.log.appendEvent("Codex Options", {
      workingDirectory: params.workspace,
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      model: normalizeModel(params.roles.main.model),
      maxTurns: params.maxTurns ?? params.roles.runtime.maxTurns
    });

    let finalResult: string | undefined;
    let turns = 0;
    const result = await thread.runStreamed(buildInitialPrompt(params), {
      signal: abortController.signal
    });

    for await (const event of result.events) {
      await params.log.appendEvent("Codex Event", event);
      if (isTurnCompleted(event)) {
        turns += 1;
        if (turns >= (params.maxTurns ?? params.roles.runtime.maxTurns)) {
          abortController.abort();
        }
      }

      const maybeFinal = extractAgentMessage(event);
      if (maybeFinal) {
        finalResult = maybeFinal;
      }
    }

    if (finalResult) {
      await params.log.appendSection("Final Result", finalResult);
    }

    return finalResult;
  } catch (error) {
    await params.log.appendEvent("Error", {
      message: error instanceof Error ? error.message : String(error)
    });
    throw normalizeCodexError(error);
  } finally {
    clearTimeout(timeout);
  }
}

function buildInitialPrompt(params: CodexRunParams): string {
  return `${params.roles.main.prompt}

Goal:
${params.goal}

Workspace:
${params.workspace}

Backend:
You are running through Codex SDK. The SDK boundary is a single agent thread.
Use your own judgment to inspect, edit, run commands, self-review, iterate, and finish.

Reviewer discipline to apply before final delivery:
${params.roles.reviewer.prompt}

If you need human judgment or missing context, stop and clearly ask the user in your final output.`;
}

function normalizeModel(model: string | undefined): string | undefined {
  if (!model || model === "inherit" || model === "sonnet") {
    return undefined;
  }
  return model;
}

function isTurnCompleted(event: unknown): boolean {
  return isRecord(event) && event.type === "turn.completed";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeCodexError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") {
    return new Error("Codex session timed out or exceeded max turns.");
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
