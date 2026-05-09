import { access, stat } from "node:fs/promises";
import path from "node:path";
import { getBackend } from "./backend/index.js";
import { loadRolesConfig } from "./config/roles.js";
import { createSessionLog } from "./logging/session-log.js";
import { createCliAskHuman, createLoggedAskHuman } from "./tools/ask-human.js";
import type { RunOptions, RunResult } from "./types.js";

export async function runMaspl(options: RunOptions): Promise<RunResult> {
  const workspace = path.resolve(options.workspace);
  await assertWorkspace(workspace);

  const rolesPath = path.resolve(options.rolesPath);
  await access(rolesPath);

  const roles = await loadRolesConfig(rolesPath);
  const log = await createSessionLog({ workspace, goal: options.goal });
  const backendName = options.backend ?? roles.runtime.backend;
  const backend = getBackend(backendName);
  const askHuman = createLoggedAskHuman({
    askHuman: createCliAskHuman(),
    log
  });

  await log.appendEvent("Runtime", {
    backend: backendName,
    rolesPath
  });

  const result = await backend.run({
    goal: options.goal,
    workspace,
    roles,
    log,
    askHuman,
    maxTurns: options.maxTurns,
    timeoutMs: options.timeoutMs
  });

  return {
    runId: log.runId,
    logPath: log.path,
    result
  };
}

async function assertWorkspace(workspace: string): Promise<void> {
  const info = await stat(workspace).catch(() => undefined);
  if (!info) {
    throw new Error(`Workspace does not exist: ${workspace}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${workspace}`);
  }
}
