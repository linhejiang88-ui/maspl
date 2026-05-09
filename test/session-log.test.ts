import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionLog } from "../src/logging/session-log.js";

const workspace = path.join("/private/tmp", `maspl-test-${process.pid}`);

describe("createSessionLog", () => {
  afterEach(async () => {
    // Left in place intentionally when cleanup fails; /private/tmp is ephemeral.
  });

  it("creates a session markdown file", async () => {
    await mkdir(workspace, { recursive: true });
    const log = await createSessionLog({
      workspace,
      goal: "ship it",
      runId: "test-run"
    });

    await log.appendSection("Final Result", "done");
    await log.appendEvent("SDK Message", { type: "result" });

    const content = await readFile(log.path, "utf8");
    expect(content).toContain("# MASPL Session test-run");
    expect(content).toContain("ship it");
    expect(content).toContain("Final Result");
    expect(content).toContain('"type": "result"');
  });
});
