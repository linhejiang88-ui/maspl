import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import type { RolesConfig } from "../types.js";

const permissionModeSchema = z.enum([
  "default",
  "dontAsk",
  "acceptEdits",
  "bypassPermissions",
  "plan"
]);

const agentRoleSchema = z.object({
  prompt: z.string().min(1, "prompt is required"),
  backend: z.enum(["claude", "codex"]).optional(),
  model: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  tools: z.array(z.string().min(1)).optional(),
  permissionMode: permissionModeSchema.optional()
});

const rolesConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  orchestrator: agentRoleSchema
    .extend({
      description: z.string().min(1, "orchestrator.description is required")
    })
    .optional(),
  exec: agentRoleSchema
    .extend({
      description: z.string().min(1, "exec.description is required")
    })
    .optional(),
  review: agentRoleSchema
    .extend({
      description: z.string().min(1, "review.description is required")
    })
    .optional(),
  judge: agentRoleSchema
    .extend({
      description: z.string().min(1, "judge.description is required")
    })
    .optional(),
  main: agentRoleSchema.optional(),
  reviewer: agentRoleSchema
    .extend({
      description: z.string().min(1, "reviewer.description is required")
    })
    .optional(),
  runtime: z
    .object({
      backend: z.enum(["claude", "codex"]).default("claude"),
      timeoutMs: z.number().int().positive().default(1_800_000),
      maxTurns: z.number().int().positive().default(30),
      allowedTools: z.array(z.string().min(1)).default([
        "Read",
        "Grep",
        "Glob",
        "Bash",
        "Edit",
        "MultiEdit",
        "Write"
      ]),
      disallowedTools: z.array(z.string().min(1)).default([])
    })
    .default({
      backend: "claude",
      timeoutMs: 1_800_000,
      maxTurns: 30,
      allowedTools: [
        "Read",
        "Grep",
        "Glob",
        "Bash",
        "Edit",
        "MultiEdit",
        "Write"
      ],
      disallowedTools: []
    })
});

export async function loadRolesConfig(path: string): Promise<RolesConfig> {
  const raw = await readFile(path, "utf8");
  return parseRolesConfig(raw, path);
}

export function parseRolesConfig(raw: string, source = "agentroles.yaml"): RolesConfig {
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse ${source}: ${formatError(error)}`);
  }

  const result = rolesConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid ${source}: ${issues}`);
  }

  return normalizeRolesConfig(result.data, source);
}

type ParsedRolesConfig = z.infer<typeof rolesConfigSchema>;

function normalizeRolesConfig(config: ParsedRolesConfig, source: string): RolesConfig {
  const orchestrator =
    config.orchestrator ??
    (config.main
      ? {
          ...config.main,
          description: "Dispatches work across Exec, Review, Judge, and Human."
        }
      : undefined);
  const exec =
    config.exec ??
    (config.main
      ? {
          ...config.main,
          description: "Executes the assigned task and produces artifacts."
        }
      : undefined);
  const review =
    config.review ??
    (config.reviewer
      ? {
          ...config.reviewer,
          description: config.reviewer.description
        }
      : undefined);
  const judge =
    config.judge ??
    (config.reviewer
      ? {
          ...config.reviewer,
          description: "Judges whether Exec output satisfies the goal given Review feedback.",
          prompt:
            `You are the Judge Agent. Compare the goal, Exec output, and Review feedback. Decide exactly one:
SATISFIED
Reason: <non-empty reason>

OR

NOT_SATISFIED
Reason: <why the goal or plan is not satisfied>
Modification direction: <what must change and why>
Instruction to Orchestrator: <specific next instruction>

OR

NEED_HUMAN
Reason: <why human judgment is required>
Question: <blocking question>
Options:
1. <option and impact>
2. <option and impact>
Default if blank: <default assumption>
Instruction to Orchestrator: Ask the human before continuing.`
        }
      : undefined);

  const missing = [
    ["orchestrator", orchestrator],
    ["exec", exec],
    ["review", review],
    ["judge", judge]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Invalid ${source}: missing required agents: ${missing.join(", ")}`);
  }

  return {
    version: config.version,
    orchestrator: withDefaultBackend(orchestrator!, "codex"),
    exec: withDefaultBackend(exec!, "codex"),
    review: withDefaultBackend(review!, "claude"),
    judge: withDefaultBackend(judge!, "codex"),
    runtime: config.runtime
  };
}

function withDefaultBackend<T extends { backend?: "claude" | "codex" }>(role: T, backend: "claude" | "codex"): T {
  return {
    ...role,
    backend: role.backend ?? backend
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
