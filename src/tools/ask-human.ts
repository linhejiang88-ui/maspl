import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { SessionLog } from "../logging/session-log.js";

export type AskHuman = (question: string) => Promise<string>;

export function createCliAskHuman(): AskHuman {
  return async (question: string) => {
    const rl = createInterface({ input, output });
    try {
      const prompt = formatHumanPrompt(question);
      const answer = await rl.question(prompt.text);
      if (!answer.trim()) {
        return "";
      }

      const selected = prompt.options[Number.parseInt(answer.trim(), 10) - 1];
      return selected ?? answer;
    } finally {
      rl.close();
    }
  };
}

export function createLoggedAskHuman(params: {
  askHuman: AskHuman;
  log: Pick<SessionLog, "appendEvent" | "appendTrace">;
}): AskHuman {
  return async (question: string) => {
    await params.log.appendTrace({
      agent: "Human",
      phase: "input",
      status: "started",
      summary: "Orchestrator Agent asked the human for input.",
      fromAgent: "Orchestrator Agent",
      toAgent: "Human",
      input: question
    });
    await params.log.appendEvent("Human Question", { question });
    const answer = await params.askHuman(question);
    await params.log.appendEvent("Human Answer", { question, answer });
    await params.log.appendTrace({
      agent: "Human",
      phase: "output",
      status: "completed",
      summary: "Human answered the agent question.",
      fromAgent: "Human",
      toAgent: "Orchestrator Agent",
      input: question,
      output: answer
    });
    return answer;
  };
}

export function formatHumanPrompt(question: string): { text: string; options: string[] } {
  const options = extractOptions(question);
  if (options.length === 0) {
    return {
      text: `\n${question}\n> `,
      options
    };
  }

  const numbered = options.map((option, index) => `${index + 1}. ${option}`).join("\n");
  return {
    text: `\n${stripOptions(question)}\n\n${numbered}\n\nSelect 1-${options.length}, or press Enter to leave blank.\n> `,
    options
  };
}

function extractOptions(question: string): string[] {
  const lines = question.split(/\r?\n/);
  return lines
    .map((line) => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/)?.[1])
    .filter((value): value is string => Boolean(value))
    .filter((value) => value.length <= 120);
}

function stripOptions(question: string): string {
  return question
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/.test(line))
    .join("\n")
    .trim();
}
