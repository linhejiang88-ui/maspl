import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunParams } from "../src/backend/types.js";
import { createClaudeBackend } from "../src/claude/adapter.js";
import type { ClaudeSdkModule } from "../src/claude/sdk-loader.js";
import { createCodexBackend } from "../src/codex/adapter.js";
import type { CodexSdkModule } from "../src/codex/sdk-loader.js";
import { defaultRolesYaml } from "../src/config/default-roles.js";
import { parseRolesConfig } from "../src/config/roles.js";
import { createSessionLog } from "../src/logging/session-log.js";

describe("backend agent sessions", () => {
  it("reuses one Codex thread per agent during a backend instance", async () => {
    const workspace = path.join("/private/tmp", `maspl-codex-session-${process.pid}`);
    await mkdir(workspace, { recursive: true });

    const startedThreads: Array<{ id: string; options?: Record<string, unknown> }> = [];
    let threadIndex = 0;
    const sdk: CodexSdkModule = {
      Codex: class {
        startThread(options?: Record<string, unknown>) {
          threadIndex += 1;
          const id = `thread-${threadIndex}`;
          startedThreads.push({ id, options });
          return {
            id,
            async runStreamed(input: string) {
              return {
                events: asyncIterable([
                  { type: "thread.started", thread_id: id },
                  {
                    type: "item.completed",
                    item: {
                      id: `msg-${id}`,
                      type: "agent_message",
                      text: `ok:${id}:${input.slice(0, 8)}`
                    }
                  },
                  { type: "turn.completed" }
                ])
              };
            }
          };
        }
      }
    };

    const backend = createCodexBackend(sdk);
    const params = await createParams(workspace);

    await backend.runAgent({ ...params, agent: "exec", task: "first exec task" });
    await backend.runAgent({ ...params, agent: "exec", task: "second exec task" });
    await backend.runAgent({ ...params, agent: "review", task: "review task" });

    expect(startedThreads.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
    expect(startedThreads[0]?.options?.sandboxMode).toBe("workspace-write");
    expect(startedThreads[1]?.options?.sandboxMode).toBe("read-only");

    const agentSessions = JSON.parse(await readFile(params.log.agentSessionsPath, "utf8"));
    expect(agentSessions.agents.exec.sessionId).toBe("thread-1");
    expect(agentSessions.agents.exec.source).toBe("backend");
    expect(agentSessions.agents.review.sessionId).toBe("thread-2");
    expect(agentSessions.agents.review.source).toBe("backend");
  });

  it("generates and serializes a Codex agent session when the SDK has no thread id", async () => {
    const workspace = path.join("/private/tmp", `maspl-codex-generated-session-${process.pid}`);
    await mkdir(workspace, { recursive: true });

    const sdk: CodexSdkModule = {
      Codex: class {
        startThread() {
          return {
            id: null,
            async runStreamed() {
              return {
                events: asyncIterable([
                  {
                    type: "item.completed",
                    item: {
                      id: "msg",
                      type: "agent_message",
                      text: "ok"
                    }
                  }
                ])
              };
            }
          };
        }
      }
    };

    const backend = createCodexBackend(sdk);
    const params = await createParams(workspace);

    await backend.runAgent({ ...params, agent: "exec", task: "exec task" });
    await backend.runAgent({ ...params, agent: "exec", task: "second exec task" });

    const agentSessions = JSON.parse(await readFile(params.log.agentSessionsPath, "utf8"));
    expect(agentSessions.agents.exec.sessionId).toContain("maspl-");
    expect(agentSessions.agents.exec.source).toBe("generated");
  });

  it("rejects a Codex thread id shared by different agents", async () => {
    const workspace = path.join("/private/tmp", `maspl-codex-shared-session-${process.pid}`);
    await mkdir(workspace, { recursive: true });

    const sdk: CodexSdkModule = {
      Codex: class {
        startThread() {
          return {
            id: "shared-thread",
            async runStreamed() {
              return {
                events: asyncIterable([
                  {
                    type: "item.completed",
                    item: {
                      id: "msg",
                      type: "agent_message",
                      text: "ok"
                    }
                  }
                ])
              };
            }
          };
        }
      }
    };

    const backend = createCodexBackend(sdk);
    const params = await createParams(workspace);

    await backend.runAgent({ ...params, agent: "exec", task: "exec task" });
    await expect(backend.runAgent({ ...params, agent: "review", task: "review task" })).rejects.toThrow(
      "already owned by exec"
    );
  });

  it("stops Codex when an agent exceeds its turn budget", async () => {
    const workspace = path.join("/private/tmp", `maspl-codex-turn-budget-${process.pid}`);
    await mkdir(workspace, { recursive: true });

    const sdk: CodexSdkModule = {
      Codex: class {
        startThread() {
          return {
            id: "budget-thread",
            async runStreamed() {
              return {
                events: asyncIterable([
                  { type: "turn.started" },
                  { type: "turn.completed" },
                  { type: "turn.started" }
                ])
              };
            }
          };
        }
      }
    };

    const backend = createCodexBackend(sdk);
    const params = await createParams(workspace);

    await expect(
      backend.runAgent({
        ...params,
        agent: "exec",
        task: "exec task",
        maxTurns: 1
      })
    ).rejects.toThrow("maxTurns");
  });

  it("runs Codex Exec PLAN_ONLY tasks in read-only sandbox", async () => {
    const workspace = path.join("/private/tmp", `maspl-codex-plan-only-${process.pid}`);
    await mkdir(workspace, { recursive: true });

    let options: Record<string, unknown> | undefined;
    const sdk: CodexSdkModule = {
      Codex: class {
        startThread(threadOptions?: Record<string, unknown>) {
          options = threadOptions;
          return {
            id: "plan-thread",
            async runStreamed() {
              return {
                events: asyncIterable([
                  {
                    type: "item.completed",
                    item: {
                      id: "msg",
                      type: "agent_message",
                      text: "plan"
                    }
                  }
                ])
              };
            }
          };
        }
      }
    };

    const backend = createCodexBackend(sdk);
    const params = await createParams(workspace);

    await backend.runAgent({ ...params, agent: "exec", task: "PLAN_ONLY: propose an implementation plan" });

    expect(options?.sandboxMode).toBe("read-only");
  });

  it("does not treat prior PLAN_ONLY context as Codex plan-only mode", async () => {
    const workspace = path.join("/private/tmp", `maspl-codex-current-task-mode-${process.pid}`);
    await mkdir(workspace, { recursive: true });

    let options: Record<string, unknown> | undefined;
    const sdk: CodexSdkModule = {
      Codex: class {
        startThread(threadOptions?: Record<string, unknown>) {
          options = threadOptions;
          return {
            id: "execute-thread",
            async runStreamed() {
              return {
                events: asyncIterable([
                  {
                    type: "item.completed",
                    item: {
                      id: "msg",
                      type: "agent_message",
                      text: "implemented"
                    }
                  }
                ])
              };
            }
          };
        }
      }
    };

    const backend = createCodexBackend(sdk);
    const params = await createParams(workspace);

    await backend.runAgent({
      ...params,
      agent: "exec",
      task: "Task from Orchestrator:\nEXECUTE_APPROVED_PLAN: implement.\n\nPrior output mentioned PLAN_ONLY.",
      taskInstruction: "EXECUTE_APPROVED_PLAN: implement."
    });

    expect(options?.sandboxMode).toBe("workspace-write");
  });

  it("resumes Codex Exec thread with write sandbox after PLAN_ONLY approval", async () => {
    const workspace = path.join("/private/tmp", `maspl-codex-plan-execute-transition-${process.pid}`);
    await mkdir(workspace, { recursive: true });

    const startedSandboxes: unknown[] = [];
    const resumed: Array<{ id: string; sandboxMode: unknown }> = [];
    const sdk: CodexSdkModule = {
      Codex: class {
        startThread(threadOptions?: Record<string, unknown>) {
          startedSandboxes.push(threadOptions?.sandboxMode);
          return codexThread("thread-1", "plan");
        }

        resumeThread(id: string, threadOptions?: Record<string, unknown>) {
          resumed.push({ id, sandboxMode: threadOptions?.sandboxMode });
          return codexThread(id, "implemented");
        }
      }
    };

    const backend = createCodexBackend(sdk);
    const params = await createParams(workspace);

    await backend.runAgent({
      ...params,
      agent: "exec",
      task: "PLAN_ONLY: propose an implementation plan",
      taskInstruction: "PLAN_ONLY: propose an implementation plan"
    });
    await backend.runAgent({
      ...params,
      agent: "exec",
      task: "Task from Orchestrator:\nEXECUTE_APPROVED_PLAN: implement.\n\nPrior output mentioned PLAN_ONLY.",
      taskInstruction: "EXECUTE_APPROVED_PLAN: implement."
    });

    expect(startedSandboxes).toEqual(["read-only"]);
    expect(resumed).toEqual([{ id: "thread-1", sandboxMode: "workspace-write" }]);

    const agentSessions = JSON.parse(await readFile(params.log.agentSessionsPath, "utf8"));
    expect(agentSessions.agents.exec.sessionId).toBe("thread-1");
  });

  it("resumes one Claude session per agent during a backend instance", async () => {
    const workspace = path.join("/private/tmp", `maspl-claude-session-${process.pid}`);
    await mkdir(workspace, { recursive: true });

    const resumes: unknown[] = [];
    const sdk: ClaudeSdkModule = {
      async *query(args: { prompt: string; options?: Record<string, unknown> }) {
        resumes.push(args.options?.resume);
        const sessionId = `session-${args.prompt.includes("review") ? "review" : "exec"}`;
        yield {
          type: "result",
          subtype: "success",
          session_id: sessionId,
          result: `ok:${sessionId}`
        };
      }
    };

    const backend = createClaudeBackend(sdk);
    const params = await createParams(workspace);

    await backend.runAgent({ ...params, agent: "exec", task: "first exec task" });
    await backend.runAgent({ ...params, agent: "exec", task: "second exec task" });
    await backend.runAgent({ ...params, agent: "review", task: "review task" });
    await backend.runAgent({ ...params, agent: "review", task: "review again" });

    expect(resumes).toEqual([undefined, "session-exec", undefined, "session-review"]);

    const agentSessions = JSON.parse(await readFile(params.log.agentSessionsPath, "utf8"));
    expect(agentSessions.agents.exec.sessionId).toBe("session-exec");
    expect(agentSessions.agents.exec.source).toBe("backend");
    expect(agentSessions.agents.review.sessionId).toBe("session-review");
    expect(agentSessions.agents.review.source).toBe("backend");
  });

  it("uses runtime.allowedTools as a hard allowlist for Claude role tools", async () => {
    const workspace = path.join("/private/tmp", `maspl-claude-allowlist-${process.pid}`);
    await mkdir(workspace, { recursive: true });

    let allowedTools: unknown;
    const sdk: ClaudeSdkModule = {
      async *query(args: { prompt: string; options?: Record<string, unknown> }) {
        allowedTools = args.options?.allowedTools;
        yield {
          type: "result",
          subtype: "success",
          session_id: "allowlist-session",
          result: "ok"
        };
      }
    };

    const backend = createClaudeBackend(sdk);
    const params = await createParams(workspace);
    params.roles.runtime.allowedTools = ["Read", "Grep"];

    await backend.runAgent({ ...params, agent: "exec", task: "exec task" });

    expect(allowedTools).toEqual(["Read", "Grep"]);
  });

  it("runs Claude Exec PLAN_ONLY tasks with plan permission and read-only tools", async () => {
    const workspace = path.join("/private/tmp", `maspl-claude-plan-only-${process.pid}`);
    await mkdir(workspace, { recursive: true });

    let permissionMode: unknown;
    let allowedTools: unknown;
    const sdk: ClaudeSdkModule = {
      async *query(args: { prompt: string; options?: Record<string, unknown> }) {
        permissionMode = args.options?.permissionMode;
        allowedTools = args.options?.allowedTools;
        yield {
          type: "result",
          subtype: "success",
          session_id: "plan-session",
          result: "plan"
        };
      }
    };

    const backend = createClaudeBackend(sdk);
    const params = await createParams(workspace);

    await backend.runAgent({ ...params, agent: "exec", task: "PLAN_ONLY: propose an implementation plan" });

    expect(permissionMode).toBe("plan");
    expect(allowedTools).toEqual(["Read", "Grep", "Glob", "Bash"]);
  });

  it("does not treat prior PLAN_ONLY context as Claude plan-only mode", async () => {
    const workspace = path.join("/private/tmp", `maspl-claude-current-task-mode-${process.pid}`);
    await mkdir(workspace, { recursive: true });

    let permissionMode: unknown;
    let allowedTools: unknown;
    const sdk: ClaudeSdkModule = {
      async *query(args: { prompt: string; options?: Record<string, unknown> }) {
        permissionMode = args.options?.permissionMode;
        allowedTools = args.options?.allowedTools;
        yield {
          type: "result",
          subtype: "success",
          session_id: "execute-session",
          result: "implemented"
        };
      }
    };

    const backend = createClaudeBackend(sdk);
    const params = await createParams(workspace);

    await backend.runAgent({
      ...params,
      agent: "exec",
      task: "Task from Orchestrator:\nEXECUTE_APPROVED_PLAN: implement.\n\nPrior output mentioned PLAN_ONLY.",
      taskInstruction: "EXECUTE_APPROVED_PLAN: implement."
    });

    expect(permissionMode).toBe("acceptEdits");
    expect(allowedTools).toEqual(["Read", "Grep", "Glob", "Bash", "Edit", "MultiEdit", "Write"]);
  });

  it("generates and serializes a Claude agent session when the SDK returns no session id", async () => {
    const workspace = path.join("/private/tmp", `maspl-claude-generated-session-${process.pid}`);
    await mkdir(workspace, { recursive: true });

    const sdk: ClaudeSdkModule = {
      async *query() {
        yield {
          type: "result",
          subtype: "success",
          result: "ok"
        };
      }
    };

    const backend = createClaudeBackend(sdk);
    const params = await createParams(workspace);

    await backend.runAgent({ ...params, agent: "exec", task: "exec task" });
    await backend.runAgent({ ...params, agent: "exec", task: "second exec task" });

    const agentSessions = JSON.parse(await readFile(params.log.agentSessionsPath, "utf8"));
    expect(agentSessions.agents.exec.sessionId).toContain("maspl-");
    expect(agentSessions.agents.exec.source).toBe("generated");
  });

  it("rejects a Claude session id shared by different agents", async () => {
    const workspace = path.join("/private/tmp", `maspl-claude-shared-session-${process.pid}`);
    await mkdir(workspace, { recursive: true });

    const sdk: ClaudeSdkModule = {
      async *query() {
        yield {
          type: "result",
          subtype: "success",
          session_id: "shared-session",
          result: "ok"
        };
      }
    };

    const backend = createClaudeBackend(sdk);
    const params = await createParams(workspace);

    await backend.runAgent({ ...params, agent: "exec", task: "exec task" });
    await expect(backend.runAgent({ ...params, agent: "review", task: "review task" })).rejects.toThrow(
      "already owned by exec"
    );
  });
});

async function createParams(workspace: string): Promise<Omit<AgentRunParams, "agent" | "task">> {
  const roles = parseRolesConfig(defaultRolesYaml);
  const log = await createSessionLog({
    workspace,
    goal: "test per-agent sessions",
    runId: `session-test-${Math.random().toString(36).slice(2, 8)}`
  });

  return {
    goal: "test per-agent sessions",
    workspace,
    roles,
    log
  };
}

function asyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    }
  };
}

function codexThread(id: string, text: string) {
  return {
    id,
    async runStreamed() {
      return {
        events: asyncIterable([
          {
            type: "item.completed",
            item: {
              id: `msg-${id}`,
              type: "agent_message",
              text
            }
          }
        ])
      };
    }
  };
}
