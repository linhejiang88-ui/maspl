import { randomUUID } from "node:crypto";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

export type AgentTracePhase = "input" | "output" | "progress" | "handoff" | "error";

export type AgentTraceEntry = {
  agent: string;
  phase: AgentTracePhase;
  summary: string;
  status?: "started" | "running" | "completed" | "failed";
  fromAgent?: string;
  toAgent?: string;
  input?: unknown;
  output?: unknown;
  metadata?: unknown;
};

export type AgentSessionSource = "backend" | "generated";

export type AgentSessionRecord = {
  agent: string;
  sessionId: string;
  backend: string;
  source: AgentSessionSource;
  createdAt: string;
  updatedAt: string;
};

export type SessionLog = {
  runId: string;
  dir: string;
  path: string;
  resultPath: string;
  finalResultPath: string;
  agentSessionsPath: string;
  appendEvent(kind: string, value: unknown, options?: { realtime?: boolean }): Promise<void>;
  appendTrace(entry: AgentTraceEntry): Promise<void>;
  registerAgentSession(params: {
    agent: string;
    backend: string;
    sessionId?: string | null;
  }): Promise<AgentSessionRecord>;
  writeResult(body: string): Promise<void>;
};

const maxInlineChars = 3_000;

export async function createSessionLog(params: {
  workspace: string;
  workingDirectory?: string;
  finalResultPath?: string;
  goal: string;
  runId?: string;
}): Promise<SessionLog> {
  const runId = params.runId ?? createRunId();
  const dir = path.join(params.workspace, ".maspl", "runs", runId);
  const logPath = path.join(dir, "session.md");
  const resultPath = path.join(dir, "result.md");
  const workingDirectory = params.workingDirectory ?? params.workspace;
  const finalResultPath = params.finalResultPath ?? resultPath;
  const agentSessionsPath = path.join(dir, "agent-sessions.json");

  await mkdir(dir, { recursive: true });
  await writeFile(
    logPath,
    `# MASPL Session ${runId}

## Goal
${params.goal}

## Trace
Agent flow is recorded in chronological order. Long input/output values are compressed with head and tail snippets.

`,
    "utf8"
  );
  await writeFile(agentSessionsPath, formatAgentSessions(runId, new Map()), "utf8");

  let sequence = 0;
  const agentSessions = new Map<string, AgentSessionRecord>();
  const sessionOwners = new Map<string, string>();

  return {
    runId,
    dir,
    path: logPath,
    resultPath,
    finalResultPath,
    agentSessionsPath,
    appendEvent: async (kind, value, options) => {
      const content = stringifyForLog(value);
      await appendFile(
        logPath,
        `\n## ${kind}\n${fencedBlock(content, "json")}\n`,
        "utf8"
      );
      if (options?.realtime) {
        printRealtime(formatBracketLine(new Date(), "Runtime", "event", kind));
      }
    },
    appendTrace: async (entry) => {
      sequence += 1;
      const traceLines = formatBracketLines(entry);
      await appendFile(logPath, formatTraceEntry(sequence, entry, traceLines), "utf8");
      if (shouldPrintTraceRealtime(entry, traceLines)) {
        printRealtime(traceLines.join("\n"));
      }
    },
    registerAgentSession: async ({ agent, backend, sessionId }) => {
      const existing = agentSessions.get(agent);
      const previous = existing
        ? {
            sessionId: existing.sessionId,
            backend: existing.backend,
            source: existing.source
          }
        : undefined;
      const record = registerAgentSession({
        runId,
        agentSessions,
        sessionOwners,
        agent,
        backend,
        sessionId
      });
      const changed =
        !previous ||
        previous.sessionId !== record.sessionId ||
        previous.backend !== record.backend ||
        previous.source !== record.source;
      await writeFile(agentSessionsPath, formatAgentSessions(runId, agentSessions), "utf8");
      if (changed) {
        await appendFile(
          logPath,
          `\n## Agent Session Registered\n${fencedBlock(record, "json")}\n`,
          "utf8"
        );
      }
      if (changed && record.source === "backend") {
        printRealtime(
          formatBracketLine(new Date(), toAgentDisplayName(agent), "session", record.sessionId)
        );
      }
      return record;
    },
    writeResult: async (body) => {
      const content = formatResult({
        body,
        workspace: params.workspace,
        workingDirectory,
        resultPath,
        finalResultPath
      });
      await writeFile(resultPath, content, "utf8");
      if (finalResultPath !== resultPath) {
        await mkdir(path.dirname(finalResultPath), { recursive: true });
        await writeFile(finalResultPath, content, "utf8");
      }
      await appendFile(logPath, `\n## Result Artifact\n${finalResultPath}\n\nInternal copy: ${resultPath}\n`, "utf8");
      printRealtime(formatBracketLine(new Date(), "Runtime", "result", finalResultPath));
    }
  };
}

function registerAgentSession(params: {
  runId: string;
  agentSessions: Map<string, AgentSessionRecord>;
  sessionOwners: Map<string, string>;
  agent: string;
  backend: string;
  sessionId?: string | null;
}): AgentSessionRecord {
  const now = new Date().toISOString();
  const returnedSessionId = normalizeSessionId(params.sessionId);
  const existing = params.agentSessions.get(params.agent);

  if (!returnedSessionId) {
    if (existing) {
      existing.updatedAt = now;
      return existing;
    }

    const generatedSessionId = `maspl-${params.runId}-${params.agent}-${randomUUID()}`;
    const generated: AgentSessionRecord = {
      agent: params.agent,
      sessionId: generatedSessionId,
      backend: params.backend,
      source: "generated",
      createdAt: now,
      updatedAt: now
    };
    params.agentSessions.set(params.agent, generated);
    params.sessionOwners.set(generatedSessionId, params.agent);
    return generated;
  }

  const owner = params.sessionOwners.get(returnedSessionId);
  if (owner && owner !== params.agent) {
    throw new Error(`Session id ${returnedSessionId} is already owned by ${owner}; ${params.agent} cannot reuse it.`);
  }

  if (existing) {
    if (existing.sessionId !== returnedSessionId && existing.source !== "generated") {
      throw new Error(
        `Agent ${params.agent} already owns session id ${existing.sessionId}; cannot replace it with ${returnedSessionId}.`
      );
    }
    if (existing.sessionId !== returnedSessionId) {
      params.sessionOwners.delete(existing.sessionId);
    }
    existing.sessionId = returnedSessionId;
    existing.backend = params.backend;
    existing.source = "backend";
    existing.updatedAt = now;
    params.sessionOwners.set(returnedSessionId, params.agent);
    return existing;
  }

  const backendRecord: AgentSessionRecord = {
    agent: params.agent,
    sessionId: returnedSessionId,
    backend: params.backend,
    source: "backend",
    createdAt: now,
    updatedAt: now
  };
  params.agentSessions.set(params.agent, backendRecord);
  params.sessionOwners.set(returnedSessionId, params.agent);
  return backendRecord;
}

function normalizeSessionId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function formatAgentSessions(runId: string, agentSessions: Map<string, AgentSessionRecord>): string {
  return `${JSON.stringify(
    {
      runId,
      updatedAt: new Date().toISOString(),
      agents: Object.fromEntries([...agentSessions.entries()].sort(([left], [right]) => left.localeCompare(right)))
    },
    null,
    2
  )}\n`;
}

function formatResult(params: {
  body: string;
  workspace: string;
  workingDirectory: string;
  resultPath: string;
  finalResultPath: string;
}): string {
  const relativeResultPath = path.relative(params.workspace, params.resultPath);
  const relativeFinalResultPath = path.relative(params.workingDirectory, params.finalResultPath);
  return `# MASPL Result

## Current Working Directory
${params.workingDirectory}

## MASPL Workspace
${params.workspace}

## Final Result Document
${params.finalResultPath}

## Internal Run Result Copy
${params.resultPath}

## Output And Usage
${params.body.trim() || "(no final output)"}

## How To Use Or Verify
Use the files, paths, and commands described in "Output And Usage" above. The final result document is stored at \`${relativeFinalResultPath}\` relative to the current working directory. MASPL also keeps an internal run copy at \`${relativeResultPath}\` inside the artifact workspace.
`;
}

function formatTraceEntry(sequence: number, entry: AgentTraceEntry, traceLines: string[]): string {
  const lines = [
    `\n### ${sequence}. ${entry.agent} ${entry.phase}${entry.status ? ` (${entry.status})` : ""}`,
    "",
    ...traceLines,
    "",
    `- time: ${formatDisplayTimestamp(new Date())}`,
    `- summary: ${entry.summary}`
  ];

  if (entry.fromAgent || entry.toAgent) {
    lines.push(`- flow: ${entry.fromAgent ?? "unknown"} -> ${entry.toAgent ?? "unknown"}`);
  }

  if (entry.input !== undefined) {
    lines.push("", "**Input**", "", fencedBlock(entry.input));
  }

  if (entry.output !== undefined) {
    lines.push("", "**Output**", "", fencedBlock(entry.output));
  }

  if (entry.metadata !== undefined) {
    lines.push("", "**Metadata**", "", fencedBlock(entry.metadata));
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatBracketLines(entry: AgentTraceEntry): string[] {
  const time = new Date();
  const lines: string[] = [];

  if (entry.phase === "handoff" && (entry.fromAgent || entry.toAgent)) {
    return [
      formatBracketLine(time, entry.agent, "handoff", `${entry.fromAgent ?? "unknown"} -> ${entry.toAgent ?? "unknown"}`)
    ];
  }

  if (entry.status === "started") {
    lines.push(formatBracketLine(time, entry.agent, entry.phase, "start run"));
  }

  if (entry.input !== undefined) {
    lines.push(formatBracketLine(time, entry.agent, "input", previewValue(entry.input)));
  }

  if (entry.status === "running") {
    lines.push(formatBracketLine(time, entry.agent, entry.phase, "running"));
  }

  if (entry.fromAgent || entry.toAgent) {
    lines.push(
      formatBracketLine(time, entry.agent, "handoff", `${entry.fromAgent ?? "unknown"} -> ${entry.toAgent ?? "unknown"}`)
    );
  }

  if (entry.output !== undefined) {
    lines.push(formatBracketLine(time, entry.agent, "output", previewValue(entry.output)));
  }

  if (entry.status === "completed") {
    lines.push(formatBracketLine(time, entry.agent, entry.phase, "end"));
  }

  if (entry.status === "failed" || entry.phase === "error") {
    lines.push(formatBracketLine(time, entry.agent, entry.phase, "error"));
  }

  if (lines.length === 0) {
    lines.push(formatBracketLine(time, entry.agent, entry.phase, entry.summary));
  }

  return lines;
}

function shouldPrintTraceRealtime(entry: AgentTraceEntry, traceLines: string[]): boolean {
  if (traceLines.length === 0) {
    return false;
  }

  if (entry.phase === "error" || entry.status === "failed") {
    return true;
  }

  if (entry.agent.endsWith("SDK") && entry.phase === "progress") {
    return false;
  }

  if (entry.phase === "progress" && isNoisyLifecycleSummary(entry.summary)) {
    return false;
  }

  return true;
}

function isNoisyLifecycleSummary(summary: string): boolean {
  return /^(Codex thread started\.|Codex turn started\.|Codex turn completed\.|Claude system event:|Claude message:|Codex emitted |Codex item update:)/.test(
    summary
  );
}

function formatBracketLine(time: Date, agent: string, type: string, message: string): string {
  return `- [${formatDisplayTimestamp(time)}]-[${agent}]-[${type}]-[${sanitizeInline(message)}]`;
}

export function formatDisplayTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function fencedBlock(value: unknown, language = ""): string {
  const content = stringifyForLog(value);
  const fence = chooseFence(content);
  return `${fence}${language}\n${content}\n${fence}`;
}

function stringifyForLog(value: unknown): string {
  const text = typeof value === "string" ? value : safeJsonStringify(value);
  return compressText(text ?? String(value), maxInlineChars);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function chooseFence(content: string): string {
  const matches = content.match(/`{3,}/g) ?? [];
  const maxFenceLength = matches.reduce((max, match) => Math.max(max, match.length), 2);
  return "`".repeat(maxFenceLength + 1);
}

function sanitizeInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toAgentDisplayName(agent: string): string {
  switch (agent) {
    case "orchestrator":
      return "Orchestrator Agent";
    case "exec":
      return "Exec Agent";
    case "review":
      return "Review Agent";
    case "judge":
      return "Judge Agent";
    default:
      return agent;
  }
}

function previewValue(value: unknown): string {
  const text = sanitizeInline(typeof value === "string" ? value : safeJsonStringify(value));
  if (text.length <= 100) {
    return text;
  }

  return `${text.slice(0, 50)}...[omitted ${text.length - 100} chars]...${text.slice(-50)}`;
}

function printRealtime(message: string): void {
  console.log(message.startsWith("- ") ? message : `- ${message}`);
}

export function compressText(text: string, maxChars = maxInlineChars): string {
  if (text.length <= maxChars) {
    return text;
  }

  const marker = `\n\n[compressed: omitted ${text.length - maxChars} chars]\n\n`;
  const headChars = Math.floor(maxChars * 0.65);
  const tailChars = maxChars - headChars;
  return `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`;
}

export function createRunId(date = new Date()): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}`;
}
