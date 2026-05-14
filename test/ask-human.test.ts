import { beforeEach, describe, expect, it, vi } from "vitest";
import { select, text } from "@clack/prompts";
import {
  buildSelectChoices,
  createCliAskHuman,
  createLoggedAskHuman,
  formatHumanPrompt,
  parseHumanQuestionBlocks
} from "../src/tools/ask-human.js";

const cancelSymbol = Symbol("cancel");

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn((value) => value === cancelSymbol)
}));

const mockedSelect = vi.mocked(select);
const mockedText = vi.mocked(text);

beforeEach(() => {
  vi.clearAllMocks();
});

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

  it("builds clack select choices with blank default first", () => {
    const choices = buildSelectChoices(`请选择调研目的：
- 择校
- 政策了解`);

    expect(choices).toEqual([
      { value: "", label: "Use default / leave blank" },
      { value: "择校", label: "择校" },
      { value: "政策了解", label: "政策了解" },
      { value: "__MASPL_CUSTOM_ANSWER__", label: "Other / custom answer" }
    ]);
  });

  it("parses multi-question clarification blocks with per-question defaults", () => {
    const blocks = parseHumanQuestionBlocks(`Exec Agent 返回 CLARIFICATION_BLOCKED，需要确认调研边界。
1. 调研结果给谁用？
1. 教研/课程设计人员：重点放课程标准、知识体系、教学设计、评估方式。
2. 家长/学生辅导：重点放学习难点、练习资源、提分路径。
3. 教育产品/AI 学习产品：重点放知识图谱、题型、诊断评估、内容资源结构。
Default if blank：3
2. 最终希望交付什么形式？
1. 研究报告：适合系统梳理和决策阅读。
2. 表格/知识框架：适合后续建库、拆任务或产品设计。
3. 报告 + 表格附录：兼顾阅读和结构化复用。
Default if blank：3`);

    expect(blocks).toEqual([
      {
        question: "调研结果给谁用？",
        options: [
          "教研/课程设计人员：重点放课程标准、知识体系、教学设计、评估方式。",
          "家长/学生辅导：重点放学习难点、练习资源、提分路径。",
          "教育产品/AI 学习产品：重点放知识图谱、题型、诊断评估、内容资源结构。"
        ],
        defaultAnswer: "教育产品/AI 学习产品：重点放知识图谱、题型、诊断评估、内容资源结构。"
      },
      {
        question: "最终希望交付什么形式？",
        options: [
          "研究报告：适合系统梳理和决策阅读。",
          "表格/知识框架：适合后续建库、拆任务或产品设计。",
          "报告 + 表格附录：兼顾阅读和结构化复用。"
        ],
        defaultAnswer: "报告 + 表格附录：兼顾阅读和结构化复用。"
      }
    ]);
  });

  it("returns the selected option from the cli prompt", async () => {
    mockedSelect.mockResolvedValueOnce("政策了解");

    const askHuman = createCliAskHuman();

    await expect(
      askHuman(`请选择调研目的：
1. 择校
2. 政策了解`)
    ).resolves.toBe("政策了解");
    expect(mockedSelect).toHaveBeenCalledWith({
      message: "请选择调研目的：",
      options: [
        { value: "", label: "Use default / leave blank" },
        { value: "择校", label: "择校" },
        { value: "政策了解", label: "政策了解" },
        { value: "__MASPL_CUSTOM_ANSWER__", label: "Other / custom answer" }
      ],
      initialValue: "",
      maxItems: 4
    });
  });

  it("shows all plan approval choices without treating plan numbering as options", async () => {
    mockedSelect.mockResolvedValueOnce("Do not execute - stop after the approved plan.");

    const askHuman = createCliAskHuman();

    await expect(
      askHuman(`Judge returned SATISFIED for PLAN_ONLY version 1. Review the approved plan below before choosing whether to execute it.

Approved PLAN_ONLY output:
1. Inspect the project.
2. Write the report.

Confirm whether runtime should execute the approved plan.
1. Approve execution - continue with EXECUTE_APPROVED_PLAN.
2. Do not execute - stop after the approved plan.
3. Modify plan/scope - return to PLAN_ONLY with human feedback.
Default if blank: Do not execute.`)
    ).resolves.toBe("Do not execute - stop after the approved plan.");

    expect(mockedSelect).toHaveBeenCalledWith({
      message: `Judge returned SATISFIED for PLAN_ONLY version 1. Review the approved plan below before choosing whether to execute it.

Approved PLAN_ONLY output:
1. Inspect the project.
2. Write the report.

Confirm whether runtime should execute the approved plan.`,
      options: [
        { value: "", label: "Use default / leave blank" },
        {
          value: "Approve execution - continue with EXECUTE_APPROVED_PLAN.",
          label: "Approve execution - continue with EXECUTE_APPROVED_PLAN."
        },
        {
          value: "Do not execute - stop after the approved plan.",
          label: "Do not execute - stop after the approved plan."
        },
        {
          value: "Modify plan/scope - return to PLAN_ONLY with human feedback.",
          label: "Modify plan/scope - return to PLAN_ONLY with human feedback."
        },
        { value: "__MASPL_CUSTOM_ANSWER__", label: "Other / custom answer" }
      ],
      initialValue: "",
      maxItems: 5
    });
  });

  it("asks multi-question clarification prompts one question at a time", async () => {
    mockedSelect
      .mockResolvedValueOnce("教育产品/AI 学习产品：重点放知识图谱、题型、诊断评估、内容资源结构。")
      .mockResolvedValueOnce("报告 + 表格附录：兼顾阅读和结构化复用。");

    const askHuman = createCliAskHuman();

    await expect(
      askHuman(`Exec Agent 返回 CLARIFICATION_BLOCKED，需要确认调研边界。
1. 调研结果给谁用？
1. 教研/课程设计人员：重点放课程标准、知识体系、教学设计、评估方式。
2. 家长/学生辅导：重点放学习难点、练习资源、提分路径。
3. 教育产品/AI 学习产品：重点放知识图谱、题型、诊断评估、内容资源结构。
Default if blank：3
2. 最终希望交付什么形式？
1. 研究报告：适合系统梳理和决策阅读。
2. 表格/知识框架：适合后续建库、拆任务或产品设计。
3. 报告 + 表格附录：兼顾阅读和结构化复用。
Default if blank：3`)
    ).resolves.toBe(`Question: 调研结果给谁用？
Answer: 教育产品/AI 学习产品：重点放知识图谱、题型、诊断评估、内容资源结构。
Question: 最终希望交付什么形式？
Answer: 报告 + 表格附录：兼顾阅读和结构化复用。`);

    expect(mockedSelect).toHaveBeenCalledTimes(2);
    expect(mockedSelect.mock.calls[0]?.[0]).toMatchObject({
      message: "1/2 调研结果给谁用？",
      options: [
        {
          value: "教研/课程设计人员：重点放课程标准、知识体系、教学设计、评估方式。",
          label: "教研/课程设计人员：重点放课程标准、知识体系、教学设计、评估方式。"
        },
        {
          value: "家长/学生辅导：重点放学习难点、练习资源、提分路径。",
          label: "家长/学生辅导：重点放学习难点、练习资源、提分路径。"
        },
        {
          value: "教育产品/AI 学习产品：重点放知识图谱、题型、诊断评估、内容资源结构。",
          label: "教育产品/AI 学习产品：重点放知识图谱、题型、诊断评估、内容资源结构。"
        },
        { value: "", label: "leave blank" }
      ],
      initialValue: "教育产品/AI 学习产品：重点放知识图谱、题型、诊断评估、内容资源结构。",
      maxItems: 4
    });
    expect(mockedSelect.mock.calls[1]?.[0]).toMatchObject({
      message: "2/2 最终希望交付什么形式？",
      initialValue: "报告 + 表格附录：兼顾阅读和结构化复用。"
    });
  });

  it("returns blank when the blank default option is selected", async () => {
    mockedSelect.mockResolvedValueOnce("");

    const askHuman = createCliAskHuman();

    await expect(
      askHuman(`请选择调研目的：
1. 择校`)
    ).resolves.toBe("");
  });

  it("uses text input when no options are present", async () => {
    mockedText.mockResolvedValueOnce("manual answer");

    const askHuman = createCliAskHuman();

    await expect(askHuman("Please clarify the scope.")).resolves.toBe("manual answer");
    expect(mockedText).toHaveBeenCalledWith({
      message: "Please clarify the scope.",
      defaultValue: ""
    });
  });

  it("allows a custom answer from an option prompt", async () => {
    mockedSelect.mockResolvedValueOnce("__MASPL_CUSTOM_ANSWER__");
    mockedText.mockResolvedValueOnce("custom scope details");

    const askHuman = createCliAskHuman();

    await expect(
      askHuman(`Choose scope:
1. web
2. cli`)
    ).resolves.toBe("custom scope details");
    expect(mockedText).toHaveBeenCalledWith({
      message: `Choose scope:
1. web
2. cli`,
      defaultValue: ""
    });
  });

  it("returns blank when the prompt is cancelled", async () => {
    mockedSelect.mockResolvedValueOnce(cancelSymbol);

    const askHuman = createCliAskHuman();

    await expect(
      askHuman(`请选择调研目的：
1. 择校`)
    ).resolves.toBe("");
  });
});
