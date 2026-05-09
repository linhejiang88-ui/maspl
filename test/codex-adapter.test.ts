import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRolesYaml } from "../src/config/default-roles.js";
import { parseRolesConfig } from "../src/config/roles.js";
import { runCodexSession } from "../src/codex/adapter.js";
import { createSessionLog } from "../src/logging/session-log.js";

describe("runCodexSession", () => {
  it("streams codex events into the session log", async () => {
    const workspace = path.join("/private/tmp", `maspl-codex-${process.pid}`);
    await mkdir(workspace, { recursive: true });
    const roles = parseRolesConfig(defaultRolesYaml);
    const log = await createSessionLog({ workspace, goal: "test", runId: "codex-test" });

    const result = await runCodexSession({
      goal: "test",
      workspace,
      roles,
      log,
      askHuman: async () => "unused",
      sdk: {
        Codex: class {
          startThread() {
            return {
              id: "thread",
              async runStreamed() {
                return {
                  events: (async function* () {
                    yield {
                      type: "item.completed",
                      item: {
                        type: "agent_message",
                        id: "1",
                        text: "done"
                      }
                    };
                    yield {
                      type: "turn.completed",
                      usage: {
                        input_tokens: 1,
                        cached_input_tokens: 0,
                        output_tokens: 1,
                        reasoning_output_tokens: 0
                      }
                    };
                  })()
                };
              }
            };
          }
        }
      }
    });

    expect(result).toBe("done");
    const content = await readFile(log.path, "utf8");
    expect(content).toContain("Codex Backend Notice");
    expect(content).toContain("Final Result");
  });
});
