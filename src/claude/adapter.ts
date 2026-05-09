import { z } from "zod";
import type { AgentBackend, AgentBackendRunParams } from "../backend/types.js";
import type { SessionLog } from "../logging/session-log.js";
import type { AskHuman } from "../tools/ask-human.js";
import type { RolesConfig } from "../types.js";
import { loadClaudeSdk, type ClaudeSdkModule } from "./sdk-loader.js";

export type ClaudeRunParams = {
  goal: string;
  workspace: string;
  roles: RolesConfig;
  log: SessionLog;
  askHuman: AskHuman;
  maxTurns?: number;
  timeoutMs?: number;
  sdk?: ClaudeSdkModule;
};

export const claudeBackend: AgentBackend = {
  name: "claude",
  run(params: AgentBackendRunParams) {
    return runClaudeSession(params);
  }
};

export async function runClaudeSession(params: ClaudeRunParams): Promise<string | undefined> {
  const sdk = params.sdk ?? (await loadClaudeSdk());
  const abortController = new AbortController();
  const timeoutMs = params.timeoutMs ?? params.roles.runtime.timeoutMs;
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const askHumanTool = sdk.tool(
      "ask_human",
      "Ask the human for judgment or missing context. Use only when progress needs human input.",
      { question: z.string().min(1) },
      async (args) => {
        const question = String(args.question ?? "");
        if (!question.trim()) {
          return {
            content: [{ type: "text", text: "question is required" }],
            isError: true
          };
        }

        const answer = await params.askHuman(question);
        return {
          content: [{ type: "text", text: answer }],
          structuredContent: { answer }
        };
      },
      {
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false
        },
        alwaysLoad: true
      }
    );

    const masplTools = sdk.createSdkMcpServer({
      name: "maspl",
      version: "0.1.0",
      tools: [askHumanTool]
    });

    const allowedTools = ensureAllowedTools(params.roles.runtime.allowedTools);
    const options = {
      cwd: params.workspace,
      maxTurns: params.maxTurns ?? params.roles.runtime.maxTurns,
      abortController,
      model: params.roles.main.model,
      permissionMode: params.roles.main.permissionMode ?? "acceptEdits",
      allowedTools,
      disallowedTools: params.roles.runtime.disallowedTools,
      mcpServers: {
        maspl: masplTools
      },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: params.roles.main.prompt
      },
      agents: {
        reviewer: {
          description: params.roles.reviewer.description,
          prompt: params.roles.reviewer.prompt,
          tools: params.roles.reviewer.tools ?? ["Read", "Grep", "Glob"],
          model: params.roles.reviewer.model,
          maxTurns: params.roles.reviewer.maxTurns,
          permissionMode: params.roles.reviewer.permissionMode ?? "plan"
        }
      }
    };

    await params.log.appendEvent("Claude Options", {
      cwd: options.cwd,
      maxTurns: options.maxTurns,
      model: options.model,
      permissionMode: options.permissionMode,
      allowedTools,
      reviewer: {
        description: params.roles.reviewer.description,
        tools: options.agents.reviewer.tools,
        model: options.agents.reviewer.model,
        permissionMode: options.agents.reviewer.permissionMode
      }
    });

    let finalResult: string | undefined;
    for await (const message of sdk.query({
      prompt: buildInitialPrompt(params.goal, params.workspace),
      options
    })) {
      await params.log.appendEvent("SDK Message", summarizeSdkMessage(message));
      const maybeResult = extractResult(message);
      if (maybeResult) {
        finalResult = maybeResult;
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
    throw normalizeClaudeError(error);
  } finally {
    clearTimeout(timeout);
  }
}

function buildInitialPrompt(goal: string, workspace: string): string {
  return `Goal:
${goal}

Workspace:
${workspace}

Operate AI-natively. Decide your own sequence of inspect, edit, command execution,
reviewer delegation, human question, iteration, and final delivery. The reviewer
subagent is named "reviewer"; use it when independent critique would help.`;
}

function ensureAllowedTools(tools: string[]): string[] {
  const unique = new Set(tools);
  unique.add("Agent");
  unique.add("mcp__maspl__ask_human");
  return [...unique];
}

function extractResult(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  if (!("result" in message)) return undefined;
  const result = (message as { result?: unknown }).result;
  return typeof result === "string" ? result : undefined;
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

function normalizeClaudeError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") {
    return new Error("Claude session timed out.");
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
