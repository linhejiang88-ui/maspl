import { createClaudeBackend } from "../claude/adapter.js";
import { createCodexBackend } from "../codex/adapter.js";
import type { BackendName } from "../types.js";
import type { AgentBackend } from "./types.js";

const backendFactories: Record<BackendName, () => AgentBackend> = {
  claude: createClaudeBackend,
  codex: createCodexBackend
};

export function getBackend(name: BackendName): AgentBackend {
  return backendFactories[name]();
}
