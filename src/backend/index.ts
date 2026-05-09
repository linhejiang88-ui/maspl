import { claudeBackend } from "../claude/adapter.js";
import { codexBackend } from "../codex/adapter.js";
import type { BackendName } from "../types.js";
import type { AgentBackend } from "./types.js";

const backends: Record<BackendName, AgentBackend> = {
  claude: claudeBackend,
  codex: codexBackend
};

export function getBackend(name: BackendName): AgentBackend {
  return backends[name];
}
