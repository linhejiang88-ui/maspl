import { isCancel, select, text } from "@clack/prompts";
import type { SessionLog } from "../logging/session-log.js";

export type AskHuman = (question: string) => Promise<string>;
export type SelectChoice = {
  value: string;
  label: string;
  hint?: string;
};
export type HumanQuestionBlock = {
  question: string;
  options: string[];
  defaultAnswer?: string;
};

const customAnswerValue = "__MASPL_CUSTOM_ANSWER__";

export function createCliAskHuman(): AskHuman {
  return async (question: string) => {
    const blocks = parseHumanQuestionBlocks(question);
    if (blocks.length > 1) {
      return askQuestionBlocks(blocks);
    }

    const prompt = formatHumanPrompt(question);
    if (prompt.options.length > 0) {
      const answer = await select({
        message: stripOptions(question),
        options: buildSelectChoices(question),
        initialValue: ""
      });
      if (isCancel(answer)) {
        return "";
      }
      if (answer === customAnswerValue) {
        return askForCustomAnswer(question);
      }
      return answer;
    }

    return askForCustomAnswer(question);
  };
}

async function askQuestionBlocks(blocks: HumanQuestionBlock[]): Promise<string> {
  const answers: string[] = [];
  for (const [index, block] of blocks.entries()) {
    const answer = await select({
      message: `${index + 1}/${blocks.length} ${block.question}`,
      options: buildBlockSelectChoices(block),
      initialValue: block.defaultAnswer ?? ""
    });
    if (isCancel(answer)) {
      answers.push(formatBlockAnswer(block, ""));
      continue;
    }
    if (answer === customAnswerValue) {
      const custom = await askForCustomAnswer(block.question);
      answers.push(formatBlockAnswer(block, custom));
      continue;
    }
    answers.push(formatBlockAnswer(block, String(answer)));
  }
  return answers.join("\n");
}

async function askForCustomAnswer(question: string): Promise<string> {
  const answer = await text({
    message: question,
    defaultValue: ""
  });
  if (isCancel(answer) || !answer.trim()) {
    return "";
  }
  return answer;
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

export function buildSelectChoices(question: string): SelectChoice[] {
  const options = extractOptions(question);
  if (options.length === 0) return [];
  return [
    {
      value: "",
      label: "Use default / leave blank"
    },
    ...options.map((option) => ({
      value: option,
      label: option
    })),
    {
      value: customAnswerValue,
      label: "Other / custom answer"
    }
  ];
}

export function parseHumanQuestionBlocks(question: string): HumanQuestionBlock[] {
  const blocks: HumanQuestionBlock[] = [];
  let current: HumanQuestionBlock | undefined;

  for (const rawLine of question.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const defaultMatch = line.match(/^Default if blank\s*[:：]\s*(.+?)\s*$/i);
    if (defaultMatch && current) {
      current.defaultAnswer = resolveDefaultAnswer(current.options, defaultMatch[1]);
      continue;
    }

    const item = line.match(/^(?:[-*]|\d+[.)])\s+(.+?)\s*$/)?.[1] ?? line;
    if (isQuestionLine(item)) {
      current = {
        question: item,
        options: []
      };
      blocks.push(current);
      continue;
    }

    if (current && isOptionLine(line) && item.length <= 160) {
      current.options.push(item);
    }
  }

  return blocks.filter((block) => block.options.length > 0);
}

function buildBlockSelectChoices(block: HumanQuestionBlock): SelectChoice[] {
  return [
    ...block.options.map((option) => ({
      value: option,
      label: option
    })),
    {
      value: "",
      label: "leave blank"
    }
  ];
}

function formatBlockAnswer(block: HumanQuestionBlock, answer: string): string {
  const finalAnswer = answer || block.defaultAnswer || "";
  return `Question: ${block.question}\nAnswer: ${finalAnswer || "(blank)"}`;
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
    .filter((line) => !/^\s*Default if blank\s*[:：]/i.test(line))
    .join("\n")
    .trim();
}

function isOptionLine(line: string): boolean {
  return /^\s*(?:[-*]|\d+[.)])\s+/.test(line);
}

function isQuestionLine(value: string): boolean {
  return /[?？]\s*$/.test(value);
}

function resolveDefaultAnswer(options: string[], value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const index = Number.parseInt(normalized, 10);
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return options[index - 1];
  }
  return normalized;
}
