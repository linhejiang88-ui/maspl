import { describe, expect, it } from "vitest";
import { createLoggedAskHuman, formatHumanPrompt } from "../src/tools/ask-human.js";

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

  it("formats selectable options while allowing blank input", () => {
    const prompt = formatHumanPrompt(`请选择调研目的：
1. 择校
2. 政策了解
3. 行业研究`);

    expect(prompt.options).toEqual(["择校", "政策了解", "行业研究"]);
    expect(prompt.text).toContain("Select 1-3");
    expect(prompt.text).toContain("press Enter to leave blank");
    expect(prompt.text).not.toContain("1. 择校\n1. 择校");
  });
});
