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

hooks-system forwards the full pi-core event surface (pi-native names). Legacy Claude-Code-style names (`pre_tool_use`, `post_tool_use`) are kept as **deprecated aliases** that map to their pi-native equivalents (`tool_call`, `tool_result`) — old configs keep working, new configs should use the pi-native names. `agent_end` and `session_start` kept their names (no alias needed).

| Event (pi-native) | Legacy alias | Triggers When | Modify? |
|-------|-------|--------------|----------|
| `tool_call` | `pre_tool_use` | Before any tool executes | **patch input** / **block** |
| `tool_result` | `post_tool_use` | After tool execution completes | **replace result** (content/details/isError) |
| `message_end` | — | Message finalized | **replace message** (same role) |
| `agent_end` | — | Agent finishes a turn / wants to stop | inject (triggerTurn) |
| `session_start` | — | Session initialization | inject (steer) |
| `session_shutdown` | — | Session runtime torn down | notification only |
| `session_before_switch` / `session_before_fork` / `session_before_compact` / `session_before_tree` / `session_compact` / `session_tree` | — | Session lifecycle transitions | notification only |
| `before_agent_start` / `agent_start` | — | Agent lifecycle | notification only |
| `turn_start` / `turn_end` | — | Turn lifecycle | notification only |
| `message_start` / `message_update` | — | Message streaming | notification only |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | — | Tool execution lifecycle | notification only |
| `before_provider_request` / `after_provider_response` | — | Provider call lifecycle | notification only |
| `model_select` / `thinking_level_select` | — | Model/thinking selection | notification only |
| `user_bash` / `input` | — | User input | notification only (can intercept) |

**Note:** `inject` actions on `session_start` are delivered as `steer` messages; if there is no active turn yet they may take effect on the first user turn rather than immediately.

#### Migration from CC-style event names

If your existing config uses `pre_tool_use` / `post_tool_use`, it still works (deprecated alias). To migrate, rename to `tool_call` / `tool_result`:
```diff
- "event": "pre_tool_use"
+ "event": "tool_call"
```

#### Claude Code events with no pi-core equivalent

These CC hook events have no pi-core counterpart and are **not** synthesized:
- `SubagentStart` / `SubagentStop` — pi models subagents differently (via `spawn_role`); use the `pi-roles` extension for subagent visibility instead.
- `PreCompact` — use pi's `session_before_compact` / `session_compact` instead.
- `FileChanged` — pi has no file-watch event; run checks on `tool_result` (write/edit) instead.

### Modify capability (exec hook stdout → JSON instruction)

An `exec` hook can **modify** the event by printing a JSON instruction to stdout. This bridges the external shell process model with pi-core's in-process mutation contract. If stdout is not a JSON instruction (plain text or non-instruction JSON), it is ignored — back-compatible with existing exec hooks.

| Instruction | Applies on | Effect |
|------|------|------|
| `{"patch":{"input":{...}}}` | `tool_call` | Merge into `event.input` before execution (mutates args) |
| `{"block":true,"reason":"..."}` | `tool_call` | Block execution |
| `{"replaceResult":{"content?":...,"details?":...,"isError?":...}}` | `tool_result` | Partial patch; omitted fields keep current values |
| `{"replaceMessage":{"message":{...}}}` | `message_end` | Replace finalized message (must keep same role) |

Example — rewrite a bash command to a safer form before it runs:
```json
{
  "event": "tool_call",
  "matcher": { "tool": "bash" },
  "action": "exec",
  "command": "echo '{\"patch\":{\"input\":{\"command\":\"echo safe\"}}}'"
}
```


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
