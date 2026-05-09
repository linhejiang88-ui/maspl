# MASPL

MASPL is a local AI Native self-play CLI for coding tasks. It lets one main agent drive the loop end to end: inspect the workspace, edit files, run commands, ask for human input when needed, call review capability when supported, iterate, and finish with a summary.

The MVP intentionally avoids a fixed `exec -> review -> judge` workflow. Runtime code only handles CLI input, backend setup, budgets, tool plumbing, and session logging.

## Status

- Language: TypeScript
- Package manager: pnpm
- Default backend: Claude Agent SDK
- Optional backend: Codex SDK
- CLI commands: `maspl init-roles`, `maspl run`
- Session logs: `<workspace>/.maspl/runs/<run-id>/session.md`

## Install

```bash
pnpm install
pnpm run build
```

This repo includes `.npmrc` pointing at `https://registry.npmmirror.com` for faster installs in China.

## Configure Roles

Create a default `agentroles.yaml`:

```bash
node dist/cli.js init-roles
```

The roles file defines:

- `main`: the main agent prompt and permissions.
- `reviewer`: the reviewer subagent prompt.
- `runtime`: backend, timeout, max turns, and tool allow/deny lists.

Example runtime block:

```yaml
runtime:
  backend: claude
  maxTurns: 30
  timeoutMs: 1800000
  allowedTools:
    - Read
    - Grep
    - Glob
    - Bash
    - Edit
    - MultiEdit
    - Write
    - Agent
    - mcp__maspl__ask_human
  disallowedTools: []
```

## Run

Claude backend:

```bash
node dist/cli.js run \
  --goal "Fix the failing tests and explain what changed" \
  --workspace /path/to/project \
  --roles agentroles.yaml \
  --backend claude
```

Codex backend:

```bash
node dist/cli.js run \
  --goal "Fix the failing tests and explain what changed" \
  --workspace /path/to/project \
  --roles agentroles.yaml \
  --backend codex
```

Useful options:

```bash
--max-turns 30
--timeout-ms 1800000
```

## Backend Behavior

### Claude

Claude is the full MVP path:

- Registers `reviewer` as a Claude Agent SDK subagent.
- Registers `ask_human(question)` as an in-process MCP tool.
- Uses Claude SDK permissions such as `permissionMode`, allowed tools, and disallowed tools.
- Streams SDK messages into the session log.

### Codex

Codex is implemented as a basic backend using `@openai/codex-sdk`:

- Starts a local Codex thread with `startThread().runStreamed()`.
- Configures workspace, sandbox, approval policy, and model.
- Writes streamed Codex events into the session log.
- Sets `skipGitRepoCheck: true` so temporary or non-git workspaces can run.

Current Codex SDK public types do not expose native subagent registration or in-process tool registration in the same shape as Claude Agent SDK. MASPL therefore does not fake a reviewer tool or `ask_human` tool for Codex; it injects the reviewer prompt as review discipline in the main prompt and asks the agent to stop with a user question when blocked.

## Logs

Each run creates:

```text
<workspace>/.maspl/runs/<run-id>/session.md
```

The log contains:

- goal
- selected backend
- backend options
- streamed SDK events
- human Q&A when `ask_human` is used
- final result or error

## Development

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

Smoke test example:

```bash
node dist/cli.js run \
  --goal "Fix the failing test, run npm test, and keep the change minimal" \
  --workspace /private/tmp/maspl-smoke-task \
  --roles agentroles.yaml \
  --backend codex \
  --max-turns 3 \
  --timeout-ms 180000
```

## Non-Goals For MVP

- No gateway integration.
- No fixed workflow state machine.
- No custom subagent call protocol.
- No independent Judge agent.
- No long-term memory or test-case management.
- No post-hoc diff permission enforcement.

