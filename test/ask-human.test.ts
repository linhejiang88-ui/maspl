import { describe, expect, it } from "vitest";
import { createLoggedAskHuman } from "../src/tools/ask-human.js";

describe("createLoggedAskHuman", () => {
  it("logs the question and answer", async () => {
    const events: Array<{ kind: string; value: unknown }> = [];
    const traces: Array<unknown> = [];
    const askHuman = createLoggedAskHuman({
      askHuman: async () => "yes",
      log: {
        appendEvent: async (kind, value) => {
          events.push({ kind, value });
        },
        appendTrace: async (entry) => {
          traces.push(entry);
        }
      }
    });

    await expect(askHuman("Proceed?")).resolves.toBe("yes");
    expect(events).toEqual([
      { kind: "Human Question", value: { question: "Proceed?" } },
      { kind: "Human Answer", value: { question: "Proceed?", answer: "yes" } }
    ]);
    expect(traces).toHaveLength(2);
    expect(JSON.stringify(traces)).toContain("Orchestrator Agent");
    expect(JSON.stringify(traces)).toContain("Human");
  });
});
