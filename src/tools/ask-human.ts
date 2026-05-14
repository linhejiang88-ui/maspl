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
const planExecutionApprovalMarker = "Confirm whether runtime should execute the approved plan.";

export function createCliAskHuman(): AskHuman {
  return async (question: string) => {
    const blocks = parseHumanQuestionBlocks(question);
    if (blocks.length > 1) {
      return askQuestionBlocks(blocks);
    }

    const prompt = formatHumanPrompt(question);
    if (prompt.options.length > 0) {
      const options = buildSelectChoices(question);
      const answer = await select({
        message: stripOptions(question),
        options,
        initialValue: initialSelectValue(question, options),
        maxItems: options.length
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
    const options = buildBlockSelectChoices(block);
    const answer = await select({
      message: `${index + 1}/${blocks.length} ${block.question}`,
      options,
      initialValue: block.defaultAnswer ?? "",
      maxItems: options.length
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
  if (isPlanExecutionApprovalQuestion(question)) {
    return [
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

function initialSelectValue(question: string, options: SelectChoice[]): string {
  if (isPlanExecutionApprovalQuestion(question)) {
    return options[0]?.value ?? "";
  }
  return "";
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
  const lines = optionScopeLines(question);
  return lines
    .map((line) => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/)?.[1])
    .filter((value): value is string => Boolean(value))
    .filter((value) => value.length <= 120);
}

function stripOptions(question: string): string {
  const lines = question.split(/\r?\n/);
  const optionStart = optionScopeStartIndex(lines);
  return lines
    .filter((line, index) => {
      if (index < optionStart) return true;
      if (/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/.test(line)) return false;
      return !/^\s*Default if blank\s*[:：]/i.test(line);
    })
    .join("\n")
    .trim();
}

function optionScopeLines(question: string): string[] {
  const lines = question.split(/\r?\n/);
  return lines.slice(optionScopeStartIndex(lines));
}

function optionScopeStartIndex(lines: string[]): number {
  const markerIndex = lines.findIndex((line) => isPlanExecutionApprovalMarker(line.trim()));
  return markerIndex >= 0 ? markerIndex + 1 : 0;
}

function isPlanExecutionApprovalQuestion(question: string): boolean {
  return question.includes("Approved PLAN_ONLY output:") && question.split(/\r?\n/).some((line) => isPlanExecutionApprovalMarker(line.trim()));
}

function isPlanExecutionApprovalMarker(line: string): boolean {
  return line === planExecutionApprovalMarker || /确认.*执行.*approved plan|是否批准.*执行|是否.*开始执行/.test(line);
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
