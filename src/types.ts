export type PermissionMode =
  | "default"
  | "dontAsk"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export type AgentRole = {
  prompt: string;
  backend?: BackendName;
  model?: string;
  maxTurns?: number;
  tools?: string[];
  permissionMode?: PermissionMode;
};

export type NamedAgentRole = AgentRole & {
  description: string;
};

export type RolesConfig = {
  version: number;
  orchestrator: NamedAgentRole;
  exec: NamedAgentRole;
  review: NamedAgentRole;
  judge: NamedAgentRole;
  runtime: {
    backend: BackendName;
    timeoutMs: number;
    maxTurns: number;
    allowedTools: string[];
    disallowedTools: string[];
  };
};

export type BackendName = "claude" | "codex";

export type RunOptions = {
  taskName: string;
  goal: string;
  workspaceRoot: string;
  rolesPath: string;
  backend?: BackendName;
  maxTurns?: number;
  timeoutMs?: number;
};

export type RunResult = {
  taskName: string;
  workspace: string;
  runId: string;
  logPath: string;
  resultPath: string;
  agentSessionsPath: string;
  result?: string;
};
