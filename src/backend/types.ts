import type { SessionLog } from "../logging/session-log.js";
import type { AskHuman } from "../tools/ask-human.js";
import type { RolesConfig } from "../types.js";

export type AgentBackendRunParams = {
  goal: string;
  workspace: string;
  roles: RolesConfig;
  log: SessionLog;
  askHuman: AskHuman;
  maxTurns?: number;
  timeoutMs?: number;
};

export type AgentBackend = {
  name: string;
  run(params: AgentBackendRunParams): Promise<string | undefined>;
};
