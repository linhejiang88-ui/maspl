# MASPL

MASPL is a local multi-agent self-play CLI for coding tasks. It runs four explicit agents:

- `Orchestrator Agent`: receives the user goal and all agent outputs, then decides which agent runs next and what task it should execute.
- `Exec Agent`: plans and performs concrete workspace changes.
- `Review Agent`: reviews Exec output and raises risks or objections.
- `Judge Agent`: decides whether the result is `SATISFIED`, `NOT_SATISFIED`, or `NEED_HUMAN`.

Claude and Codex are backend adapters only. They run the selected agent task; they do not own the orchestration logic.

## Requirements

- Node.js 22+
- pnpm
- Local Claude Code CLI installed, logged in, and available on `PATH` when using `--backend claude`
- Local Codex CLI installed, logged in, and available on `PATH` when using `--backend codex`

MASPL reuses the local CLI auth/session environment through the Claude Agent SDK and Codex SDK. Install and verify those CLIs before running MASPL.

## Install

```bash
pnpm install
pnpm run build
```

The repo includes `.npmrc` with the npmmirror registry for faster dependency installs in China.

## Configure Roles

Create a default roles file:

```bash
node dist/cli.js init-roles
```

This creates `agentroles.yaml` with prompts, permissions, tool scopes, runtime budget, and backend defaults for the four agents.

## Run

Claude backend:

```bash
node dist/cli.js run \
  --task-name fix-tests-demo \
  --goal "Fix the failing tests and explain what changed" \
  --roles agentroles.yaml \
  --backend claude
```

Codex backend:

```bash
node dist/cli.js run \
  --task-name fix-tests-demo \
  --goal "Fix the failing tests and explain what changed" \
  --roles agentroles.yaml \
  --backend codex
```

Useful options:

```bash
--workspace ~/.maspl/project
--max-turns 30
--timeout-ms 1800000
```

`--task-name` is required and must be a single path segment. By default, MASPL runs inside:

```text
~/.maspl/project/<task_name>/
```

If `--workspace <root>` is provided, MASPL runs inside:

```text
<root>/<task_name>/
```

## Multi-Agent Flow

```mermaid
flowchart TD
  User["User Goal"] --> Orchestrator["Orchestrator Agent"]
  Orchestrator -->|"NEXT_AGENT: exec\nTASK: implement"| Exec["Exec Agent"]
  Exec -->|"result, changed files, verification"| Orchestrator
  Orchestrator -->|"NEXT_AGENT: review\nTASK: review Exec output"| Review["Review Agent"]
  Review -->|"findings, risks, objections"| Orchestrator
  Orchestrator -->|"NEXT_AGENT: judge\nTASK: decide satisfaction"| Judge["Judge Agent"]
  Judge -->|"SATISFIED / NOT_SATISFIED / NEED_HUMAN"| Orchestrator
  Orchestrator -->|"NEXT_AGENT: human"| Human["Human"]
  Human -->|"answer"| Orchestrator
  Orchestrator -->|"NEXT_AGENT: done"| Result["Result Artifact"]
```

The Runtime only parses Orchestrator dispatch:

```text
NEXT_AGENT: exec | review | judge | human | done
TASK:
<task for the selected agent>
```

Invalid dispatch is retried once. If it is still invalid, the run fails instead of silently treating the task as complete.

## Output

Each run writes artifacts inside the task workspace:

```text
<workspace>/.maspl/runs/<run-id>/session.md
<workspace>/.maspl/runs/<run-id>/agent-sessions.json
<workspace>/.maspl/runs/<run-id>/result.md
```

`result.md` is the final delivery artifact. It should explain what was produced, where it lives in the workspace, and how to use or verify it.

`agent-sessions.json` records the per-agent backend session ids for the run. Different agents cannot share the same session id.

## Notes

- `runtime.allowedTools` is a hard allowlist. Agent role tools are intersected with it before backend execution.
- Exec is the only role intended to modify the workspace.
- Human-in-the-Loop uses `NEXT_AGENT: human`; no backend-specific human MCP tool is required.
- Gateway integrations such as Feishu or Telegram are not part of the MVP.
