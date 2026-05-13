import type { SessionLog } from "../logging/session-log.js";
import type { RolesConfig } from "../types.js";

export type AgentRoleName = "orchestrator" | "exec" | "review" | "judge";

export type AgentRunParams = {
  agent: AgentRoleName;
  task: string;
  taskInstruction?: string;
  goal: string;
  workspace: string;
  workingDirectory: string;
  roles: RolesConfig;
  log: SessionLog;
  maxTurns?: number;
  timeoutMs?: number;
};

export type AgentBackend = {
  name: string;
  runAgent(params: AgentRunParams): Promise<string | undefined>;
};
