import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import type { RolesConfig } from "../types.js";

const permissionModeSchema = z.enum([
  "default",
  "dontAsk",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "auto"
]);

const agentRoleSchema = z.object({
  prompt: z.string().min(1, "prompt is required"),
  model: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  tools: z.array(z.string().min(1)).optional(),
  permissionMode: permissionModeSchema.optional()
});

const rolesConfigSchema = z.object({
  version: z.number().int().positive().default(1),
  main: agentRoleSchema,
  reviewer: agentRoleSchema.extend({
    description: z.string().min(1, "reviewer.description is required")
  }),
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
        "Write",
        "Agent",
        "mcp__maspl__ask_human"
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
        "Write",
        "Agent",
        "mcp__maspl__ask_human"
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

  return result.data;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
