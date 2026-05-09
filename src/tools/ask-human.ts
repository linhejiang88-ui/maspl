import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { SessionLog } from "../logging/session-log.js";

export type AskHuman = (question: string) => Promise<string>;

export function createCliAskHuman(): AskHuman {
  return async (question: string) => {
    const rl = createInterface({ input, output });
    try {
      return await rl.question(`\n${question}\n> `);
    } finally {
      rl.close();
    }
  };
}

export function createLoggedAskHuman(params: {
  askHuman: AskHuman;
  log: Pick<SessionLog, "appendEvent">;
}): AskHuman {
  return async (question: string) => {
    await params.log.appendEvent("Human Question", { question });
    const answer = await params.askHuman(question);
    await params.log.appendEvent("Human Answer", { question, answer });
    return answer;
  };
}
