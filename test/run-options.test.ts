import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProjectWorkspace } from "../src/run.js";

describe("resolveProjectWorkspace", () => {
  it("uses task_name as the default workspace under the MASPL project root", () => {
    const resolved = resolveProjectWorkspace({
      taskName: "review_edu5"
    });

    expect(resolved).toEqual({
      taskName: "review_edu5",
      workspaceRoot: path.join(os.homedir(), ".maspl", "project"),
      workspace: path.join(os.homedir(), ".maspl", "project", "review_edu5")
    });
  });

  it("rejects task_name values that are not a single path segment", () => {
    expect(() =>
      resolveProjectWorkspace({
        taskName: "../demo"
      })
    ).toThrow("single path segment");
  });
});
