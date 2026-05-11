import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProjectWorkspace } from "../src/run.js";

describe("resolveProjectWorkspace", () => {
  it("uses task_name as the project directory under the workspace root", () => {
    expect(
      resolveProjectWorkspace({
        taskName: "print-hello",
        workspaceRoot: "/tmp/maspl-projects"
      })
    ).toEqual({
      taskName: "print-hello",
      workspaceRoot: "/tmp/maspl-projects",
      workspace: "/tmp/maspl-projects/print-hello"
    });
  });

  it("expands the default home workspace root", () => {
    const resolved = resolveProjectWorkspace({
      taskName: "demo",
      workspaceRoot: "~/.maspl/project"
    });

    expect(resolved.workspaceRoot).toBe(path.join(os.homedir(), ".maspl", "project"));
    expect(resolved.workspace).toBe(path.join(os.homedir(), ".maspl", "project", "demo"));
  });

  it("rejects task_name values that are not a single path segment", () => {
    expect(() =>
      resolveProjectWorkspace({
        taskName: "../demo",
        workspaceRoot: "/tmp"
      })
    ).toThrow("single path segment");
  });
});
