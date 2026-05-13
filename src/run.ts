import { access, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getBackends } from "./backend/index.js";
import { loadRolesConfig } from "./config/roles.js";
import { createSessionLog } from "./logging/session-log.js";
import { runOrchestration } from "./orchestration/loop.js";
import { createCliAskHuman, createLoggedAskHuman } from "./tools/ask-human.js";
import type { RunOptions, RunResult } from "./types.js";

export async function runMaspl(options: RunOptions): Promise<RunResult> {
  const { taskName, workspace } = resolveProjectWorkspace(options);
  const workingDirectory = resolvePath(options.workingDirectory ?? process.cwd());
  const finalResultPath = path.join(workingDirectory, "result.md");
  await ensureWorkspace(workspace);
  await ensureWorkspace(workingDirectory);

  const rolesPath = path.resolve(options.rolesPath);
  await access(rolesPath);

  const roles = await loadRolesConfig(rolesPath);
  const log = await createSessionLog({
    workspace,
    workingDirectory,
    finalResultPath,
    goal: options.goal
  });
  const backends = getBackends();
  const askHuman = createLoggedAskHuman({
    askHuman: createCliAskHuman(),
    log
  });

  await log.appendEvent("Runtime", {
    taskName,
    backendOverride: options.backend,
    agentBackends: {
      orchestrator: options.backend ?? roles.orchestrator.backend,
      exec: options.backend ?? roles.exec.backend,
      review: options.backend ?? roles.review.backend,
      judge: options.backend ?? roles.judge.backend
    },
    workspace,
    workingDirectory,
    finalResultPath,
    rolesPath
  }, { realtime: true });

  const result = await runOrchestration({
    backends,
    backendOverride: options.backend,
    goal: options.goal,
    workspace,
    workingDirectory,
    roles,
    log,
    askHuman,
    maxTurns: options.maxTurns,
    timeoutMs: options.timeoutMs
  });

  return {
    taskName,
    workspace,
    workingDirectory,
    runId: log.runId,
    logPath: log.path,
    internalResultPath: log.resultPath,
    resultPath: log.finalResultPath,
    agentSessionsPath: log.agentSessionsPath,
    result
  };
}

export function resolveProjectWorkspace(options: Pick<RunOptions, "taskName">): {
  taskName: string;
  workspaceRoot: string;
  workspace: string;
} {
  const taskName = normalizeTaskName(options.taskName);
  const workspaceRoot = resolvePath("~/.maspl/project");
  return {
    taskName,
    workspaceRoot,
    workspace: path.join(workspaceRoot, taskName)
  };
}

async function ensureWorkspace(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  const info = await stat(workspace).catch(() => undefined);
  if (!info) {
    throw new Error(`Workspace does not exist: ${workspace}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${workspace}`);
  }
}

function normalizeTaskName(taskName: string): string {
  const normalized = taskName.trim();
  if (!normalized) {
    throw new Error("task_name is required.");
  }
  if (normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\\")) {
    throw new Error(`task_name must be a single path segment, got: ${taskName}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`task_name may only contain letters, numbers, dot, underscore, and hyphen, got: ${taskName}`);
  }
  return normalized;
}

function resolvePath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}
