# pi-hooks-system

Standardized **stateless** event hooks for Pi Agent. Configure hooks as JSON rules instead of writing TypeScript extensions.

## When to use this vs sibling packages

This is one of three hook-style extensions; they cover different capability tiers — pick by what your hook needs:

| Need | Use |
|---|---|
| Stateless declarative rule ("when tool X matches pattern Y, block/warn/inject/exec") | **pi-hooks-system** (this package) |
| Multi-step pipeline with retry state after edits (format→typecheck→lint→test) | pi-auto-fix-loop |
| Cross-turn cumulative condition with cooldown ("5 turns since last test → remind") | pi-event-reminders |

**Do not try to express stateful pipelines or cumulative conditions here.** This package matches an event once and fires a single action; it has no per-session state, no multi-step ordering, no cooldown. If your rule needs to count, accumulate, or retry, it belongs in one of the siblings above.

## Installation

```bash
pi install git:github.com/SilentMoebuta/pi-hooks-system
```

> 旧的手动复制(`cp -r`)与 `pi -e` 加载方式已废弃，请使用上面的包安装。

## Quick Start

1. Copy the example config:
```bash
cp extensions/pi-hooks-system/hooks.example.json .pi/hooks.json
```

2. Edit `.pi/hooks.json` to customize your hooks.

3. Start pi — hooks auto-load on session start.

## Configuration

Create `.pi/hooks.json` in your project root.

### Hook Structure

Each hook has:
- `event` (required): `pre_tool_use`, `post_tool_use`, `agent_end`, or `session_start`
- `action` (required): `block`, `warn`, `inject`, or `exec`
- `matcher` (optional): filter by tool name or regex pattern
  - `tool`: match specific tool (e.g., `"bash"`, `"edit"`, `"write"`)
  - `pattern`: regex to match against tool parameters
  - `resultIsError` (post_tool_use only): only fire when the tool result was an error — useful for "on failure, inject a retry hint" without firing on every successful result
- `message`, `injectPrompt`, `command`, `onFailure`: action-specific fields

### Available Events

| Event | Triggers When | Best For |
|-------|--------------|----------|
| `pre_tool_use` | Before any tool executes | Block dangerous operations, modify parameters |
| `post_tool_use` | After tool execution completes | Auto lint, format, test |
| `agent_end` | Agent finishes a turn / wants to stop | Inject verification checklist before completion |
| `session_start` | Session initialization | Load project context, coding standards. **Note:** `inject` actions on `session_start` are delivered as `steer` messages; if there is no active turn yet they may take effect on the first user turn rather than immediately. |

### Available Actions

| Action | Behavior |
|--------|----------|
| `block` | Prevent the action. Prompts for confirmation in interactive mode. |
| `inject` | Inject a message into the agent's context (steering hint) |
| `exec` | Run a shell command (30s timeout). On failure, output is injected into context by default (set `onFailure: "ignore"` to suppress). |
| `warn` | Show a warning notification to the user |

### Variable Substitution

In `command` fields for `exec` actions, use shell-escaped placeholders:
- `${FILES}` — shell-escaped path of the primary file being operated on (derived from tool input `path`)
- `${EDIT_FILE}` — same as `${FILES}` (for compatibility)

These are populated from the tool call input at runtime. Only `write`/`edit` tool inputs carry a `path` field; for `bash` and other tools `${FILES}` is empty (the file operated on, if any, is embedded inside `command` and not extracted).

## Integration with Superpowers Skills

### TDD (test-driven-development)
Use `post_tool_use` on `write`/`edit` to auto-run related tests:
```json
{
  "event": "post_tool_use",
  "matcher": { "tool": "write" },
  "action": "exec",
  "command": "npx jest --findRelatedTests ${FILES} --passWithNoTests 2>&1",
  "onFailure": "inject",
  "message": "Test failure:"
}
```

### verification-before-completion
Use `agent_end` to inject the verification checklist:
```json
{
  "event": "agent_end",
  "action": "inject",
  "injectPrompt": "Before concluding, run through the verification checklist:\n1. Tests pass\n2. No lint warnings\n3. Git status clean"
}
```

## Security Notes

- **Pattern matching uses regex.** Patterns come from your trusted `.pi/hooks.json`; do not load hooks from untrusted sources.
- **No ReDoS protection.** The length limits (pattern ≤ 200 chars, serialized input ≤ 5000 chars) are a shallow depth-defense against accidental large patterns only — they do **not** prevent catastrophic backtracking. A short pathological pattern (e.g. `(a+)+$`) with a small input can hang the agent for tens of seconds. Keep your regex patterns simple and anchored.
- **exec actions are NOT gated by plan-execute-gate.** `exec` runs via the extension API (`pi.exec`), not as an agent tool call, so Plan Mode's read-only gate does not intercept it. This is by design — hooks are user-configured authorized automation. If you have plan-execute-gate installed and want strict Plan-Mode read-only behavior, avoid `exec` hooks that mutate files.
- **Default failure behavior is `inject`.** When an `exec` command fails, its output is injected into the agent context by default so the agent can self-correct. Set `onFailure: "ignore"` to suppress injection (a truncated warning is shown to the UI instead).
- **exec has a 30-second timeout.** Hanging commands are killed and reported.
- `exec` actions skip when a previous hook has already blocked the action.

## License

MIT
