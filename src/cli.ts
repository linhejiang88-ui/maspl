#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { defaultRolesYaml } from "./config/default-roles.js";
import { runMaspl } from "./run.js";
import type { BackendName } from "./types.js";

const program = new Command();

program
  .name("maspl")
  .description("AI Native local self-play loop with Claude Agent SDK or Codex SDK")
  .version("0.1.0");

program
  .command("init-roles")
  .description("Create a default agentroles.yaml")
  .option("-o, --output <path>", "output path", "agentroles.yaml")
  .action(async (options: { output: string }) => {
    const outputPath = path.resolve(options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, defaultRolesYaml, { encoding: "utf8", flag: "wx" });
    console.log(`Created ${outputPath}`);
  });

program
  .command("run")
  .description("Run one AI Native self-play session")
  .requiredOption("-g, --goal <goal>", "goal for the Main Agent")
  .option("-w, --workspace <path>", "workspace path", ".")
  .option("-r, --roles <path>", "agentroles.yaml path", "agentroles.yaml")
  .option("-b, --backend <backend>", "backend: claude or codex", parseBackend)
  .option("--max-turns <number>", "override runtime max turns", parsePositiveInt)
  .option("--timeout-ms <number>", "override runtime timeout in milliseconds", parsePositiveInt)
  .action(
    async (options: {
      goal: string;
      workspace: string;
      roles: string;
      backend?: BackendName;
      maxTurns?: number;
      timeoutMs?: number;
    }) => {
      const result = await runMaspl({
        goal: options.goal,
        workspace: options.workspace,
        rolesPath: options.roles,
        backend: options.backend,
        maxTurns: options.maxTurns,
        timeoutMs: options.timeoutMs
      });

      console.log(`Run ${result.runId} finished.`);
      console.log(`Session log: ${result.logPath}`);
      if (result.result) {
        console.log("\nFinal result:\n");
        console.log(result.result);
      }
    }
  );

program.parseAsync(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

function parsePositiveInt(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, got: ${value}`);
  }
  return parsed;
}

function parseBackend(value: string): BackendName {
  if (value === "claude" || value === "codex") {
    return value;
  }
  throw new Error(`Expected backend to be claude or codex, got: ${value}`);
}
