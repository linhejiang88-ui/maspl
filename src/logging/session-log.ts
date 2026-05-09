import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

export type SessionLog = {
  runId: string;
  dir: string;
  path: string;
  appendSection(title: string, body: string): Promise<void>;
  appendEvent(kind: string, value: unknown): Promise<void>;
};

export async function createSessionLog(params: {
  workspace: string;
  goal: string;
  runId?: string;
}): Promise<SessionLog> {
  const runId = params.runId ?? createRunId();
  const dir = path.join(params.workspace, ".maspl", "runs", runId);
  const logPath = path.join(dir, "session.md");

  await mkdir(dir, { recursive: true });
  await writeFile(
    logPath,
    `# MASPL Session ${runId}

## Goal
${params.goal}

`,
    "utf8"
  );

  return {
    runId,
    dir,
    path: logPath,
    appendSection: async (title, body) => {
      await appendFile(logPath, `\n## ${title}\n${body.trim()}\n`, "utf8");
    },
    appendEvent: async (kind, value) => {
      await appendFile(
        logPath,
        `\n## ${kind}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`,
        "utf8"
      );
    }
  };
}

function createRunId(date = new Date()): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}`;
}
