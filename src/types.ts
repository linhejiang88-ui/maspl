export type PermissionMode =
  | "default"
  | "dontAsk"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "auto";

export type AgentRole = {
  prompt: string;
  model?: string;
  maxTurns?: number;
  tools?: string[];
  permissionMode?: PermissionMode;
};

export type ReviewerRole = AgentRole & {
  description: string;
};

export type RolesConfig = {
  version: number;
  main: AgentRole;
  reviewer: ReviewerRole;
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
  goal: string;
  workspace: string;
  rolesPath: string;
  backend?: BackendName;
  maxTurns?: number;
  timeoutMs?: number;
};

export type RunResult = {
  runId: string;
  logPath: string;
  result?: string;
};
