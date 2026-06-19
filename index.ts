/**
 * hooks-system Extension
 *
 * Configuration-driven hooks framework for Pi Agent.
 * Users configure hooks in .pi/hooks.json instead of writing TypeScript code.
 *
 * Supported events: pre_tool_use, post_tool_use, agent_end, session_start
 * Supported actions: block, warn, inject, exec
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ───────────────────────────────────────────────────────────────────

export type HookEvent = "pre_tool_use" | "post_tool_use" | "agent_end" | "session_start";

export interface HookMatcher {
  /** Tool name to match (e.g. "bash", "edit", "write") */
  tool?: string;
  /** Regex pattern to match against the serialized tool input */
  pattern?: string;
  /** For post_tool_use hooks: only fire when the tool result was an error
   *  (isError === true). Lets users condition "on failure, inject retry hint"
   *  instead of firing on every tool_result. */
  resultIsError?: boolean;
}

export interface HookDefinition {
  /** Event that triggers this hook */
  event: HookEvent;
  /** Optional matcher to filter when the hook fires */
  matcher?: HookMatcher;
  /** Action to perform */
  action: "block" | "warn" | "inject" | "exec";
  /** Message shown for block/warn, or prefix for exec failure output */
  message?: string;
  /** Prompt text injected into agent context for inject action */
  injectPrompt?: string;
  /** Shell command to run for exec action */
  command?: string;
  /** Behavior when exec command fails: inject output into context or ignore */
  onFailure?: "inject" | "ignore";
}

export interface HooksConfig {
  hooks: HookDefinition[];
}

// ── Module state ────────────────────────────────────────────────────────────
// NOTE: config is loaded fresh on each event handler invocation (see
// loadConfigFor below). hooks.json is tiny, so the IO cost is negligible and
// we avoid the multi-session cross-contamination risk of module-level cache
// (e.g. subagent sessions, RPC multi-session in one process).

// ── Config loading ──────────────────────────────────────────────────────────

/**
 * Load hooks configuration from .pi/hooks.json.
 * Returns empty config if the file doesn't exist or is malformed.
 */
export function loadHooksConfig(cwd: string): HooksConfig {
  const configPath = path.join(cwd, ".pi", "hooks.json");

  if (!fs.existsSync(configPath)) {
    return { hooks: [] };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (parsed && typeof parsed === "object" && "hooks" in parsed) {
      const hooks = (parsed as Record<string, unknown>).hooks;
      if (Array.isArray(hooks)) {
        return { hooks: hooks as HookDefinition[] };
      }
    }

    return { hooks: [] };
  } catch {
    return { hooks: [] };
  }
}

// ── Hook matching ───────────────────────────────────────────────────────────

/** Optional tool-result context passed to matchHooks for post_tool_use
 *  matching (e.g. isError). Undefined for pre_tool_use (no result yet). */
export interface HookMatchResult {
  isError?: boolean;
}

/**
 * Filter hooks that match the given event and optional tool name/input/result.
 * A hook must match both the event AND the optional matcher (if present).
 */
export function matchHooks(
  hooks: HookDefinition[],
  event: HookEvent,
  toolName?: string,
  input?: Record<string, unknown>,
  result?: HookMatchResult,
): HookDefinition[] {
  const inputStr = JSON.stringify(input ?? {});
  return hooks.filter((h) => {
    if (h.event !== event) return false;

    const matcher = h.matcher;
    if (matcher) {
      // Tool name filter
      if (matcher.tool && matcher.tool !== toolName) return false;

      // Pattern filter against serialized input
      if (matcher.pattern) {
        try {
          if (matcher.pattern.length > 200) return false; // ReDoS protection
          if (inputStr.length > 5000) return false; // ReDoS protection
          if (!new RegExp(matcher.pattern).test(inputStr)) return false;
        } catch {
          // Invalid regex in pattern — skip this hook silently
          return false;
        }
      }

      // Result-error filter (post_tool_use only): only fire when the tool
      // result was an error. result.isError is undefined for pre_tool_use.
      if (matcher.resultIsError === true && !result?.isError) return false;
    }

    return true;
  });
}

// ── Hook execution ──────────────────────────────────────────────────────────

interface HookExecutionResult {
  /** Whether the current action should be blocked */
  blocked: boolean;
  /** Messages to inject into agent context */
  injectMessages: string[];
}

interface HookRuntimeContext {
  toolName?: string;
  input?: Record<string, unknown>;
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build variables documented for exec command templates.
 */
export function buildHookVariables(
  _toolName?: string,
  input?: Record<string, unknown>,
): Record<string, string> {
  const file = typeof input?.path === "string" ? input.path : "";
  const escapedFile = file ? shellEscape(file) : "";
  return {
    FILES: escapedFile,
    EDIT_FILE: escapedFile,
  };
}

/**
 * Render ${FILES}/${EDIT_FILE} placeholders in hook exec commands.
 */
export function renderCommandTemplate(
  command: string,
  variables: Record<string, string>,
): string {
  return command.replace(/\$\{([A-Z_]+)\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
  });
}

/**
 * Execute matched hooks in order.
 * block and exec actions are async; warn and inject are synchronous.
 */
export async function executeHooks(
  matched: HookDefinition[],
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runtime: HookRuntimeContext = {},
): Promise<HookExecutionResult> {
  let blocked = false;
  const injectMessages: string[] = [];

  for (const hook of matched) {
    switch (hook.action) {
      case "block": {
        if (ctx.hasUI) {
          const confirmed = await ctx.ui.confirm(
            "Hook blocked action",
            hook.message || "This action has been blocked by a hook. Allow it?",
          );
          if (!confirmed) blocked = true;
        } else {
          // Non-interactive mode: block automatically. Always notify the
          // reason so the user/agent doesn't see an opaque tool failure.
          blocked = true;
          ctx.ui.notify(
            hook.message || "Blocked by hooks-system pre_tool_use hook",
            "warning",
          );
        }
        break;
      }

      case "warn": {
        ctx.ui.notify(hook.message || "Hook warning", "warning");
        break;
      }

      case "inject": {
        if (hook.injectPrompt) {
          injectMessages.push(hook.injectPrompt);
        }
        break;
      }

      case "exec": {
        if (blocked) break; // Don't run side-effect commands on a blocked action
        // Trust gate: never render + sh -c arbitrary shell from an untrusted
        // project's hooks.json. A cloned malicious repo could otherwise run
        // shell on the first matching tool call.
        const trusted =
          typeof (ctx as unknown as { isProjectTrusted?: () => boolean }).isProjectTrusted === "function"
            ? (ctx as unknown as { isProjectTrusted: () => boolean }).isProjectTrusted()
            : true;
        if (!trusted) {
          ctx.ui.notify(
            "hooks-system: exec hook skipped (project not trusted)",
            "warning",
          );
          break;
        }
        if (hook.command) {
          try {
            const variables = buildHookVariables(runtime.toolName, runtime.input);
            const renderedCommand = renderCommandTemplate(hook.command, variables);
            // Default 30s timeout + honor abort signal so a hanging exec command
            // cannot block the agent indefinitely.
            const result = await pi.exec("sh", ["-c", renderedCommand], {
              signal: ctx.signal,
              timeout: 30_000,
            });

            if (result.killed) {
              ctx.ui.notify(
                `hooks-system exec timed out (>30s): ${hook.command.slice(0, 80)}`,
                "warning",
              );
            } else if (result.code !== 0) {
              const failureOutput = [
                hook.message,
                result.stdout,
                result.stderr,
              ]
                .filter(Boolean)
                .join("\n")
                .trim();

              // Default: inject failure output into agent context so the agent
              // can self-correct. Only skip injection when onFailure is
              // explicitly "ignore".
              if (hook.onFailure === "ignore") {
                ctx.ui.notify(
                  `hooks-system exec failed (exit ${result.code}): ${failureOutput.slice(0, 150)}`,
                  "warning",
                );
              } else {
                injectMessages.push(failureOutput);
              }
            }
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`hooks-system exec error: ${errMsg}`, "error");
          }
        }
        break;
      }
    }
  }

  return { blocked, injectMessages };
}

// ── Message injection helpers ───────────────────────────────────────────────

/**
 * Inject messages into the agent context via pi.sendMessage.
 * Each message is sent with deliverAs: "steer" so it appears as a steering
 * hint during the current turn rather than as a new user message.
 */
function injectSteerMessages(
  pi: ExtensionAPI,
  messages: string[],
  customType: string,
): void {
  for (const msg of messages) {
    pi.sendMessage(
      { customType, content: msg, display: false },
      { deliverAs: "steer" },
    );
  }
}

/**
 * Inject a message that triggers a new agent turn.
 * Used by agent_end hooks to force the agent to verify before completing.
 */
function injectTriggerTurn(pi: ExtensionAPI, customType: string, content: string): void {
  pi.sendMessage(
    { customType, content, display: false },
    { triggerTurn: true },
  );
}

// ── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Load config fresh each time. hooks.json is tiny; the IO cost is
  // negligible and we avoid module-level cache cross-contamination between
  // sessions sharing one process (subagents, RPC multi-session).
  const loadConfigFor = (ctx: ExtensionContext): HooksConfig => loadHooksConfig(ctx.cwd);

  // ── session_start: Load config, persist, notify, inject startup hooks ───

  pi.on("session_start", (_event, ctx) => {
    const config = loadConfigFor(ctx);

    // Persist config in session for cross-restart survival
    pi.appendEntry("hooks-config", { config, cwd: ctx.cwd });

    // Notify user of loaded hooks (only when there are any — avoid noise)
    if (config.hooks.length > 0) {
      ctx.ui.notify(
        `hooks-system: ${config.hooks.length} hooks loaded`,
        "info",
      );
    }

    // Execute session_start hooks (typically inject actions for context)
    const matched = matchHooks(config.hooks, "session_start");

    // Warn about hooks whose action is not supported on session_start.
    // Only `inject` fires here; block/warn/exec are silently ignored, so
    // surface them so the user knows their hook won't fire.
    const unsupported = matched.filter((h) => h.action !== "inject");
    if (unsupported.length > 0) {
      const actions = [...new Set(unsupported.map((h) => h.action))].join(", ");
      ctx.ui.notify(
        `hooks-system: ${unsupported.length} session_start hook(s) use unsupported action(s) (${actions}); only "inject" fires on session_start`,
        "warning",
      );
    }

    const prompts = matched
      .filter((h) => h.action === "inject" && h.injectPrompt)
      .map((h) => h.injectPrompt!);

    injectSteerMessages(pi, prompts, "hooks-startup");
  });

  // ── tool_call: Process pre_tool_use hooks ────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    const config = loadConfigFor(ctx);

    const toolName = event.toolName;
    // ToolCallEvent is a discriminated union — all variants have `input`,
    // but TypeScript widens union access to the intersection of input types.
    // Cast to Record<string, unknown> for generic pattern matching.
    const input = (event as unknown as { input: Record<string, unknown> }).input;

    const matched = matchHooks(config.hooks, "pre_tool_use", toolName, input);
    const { blocked, injectMessages } = await executeHooks(matched, pi, ctx, { toolName, input });

    // Inject any messages collected during hook execution
    injectSteerMessages(pi, injectMessages, "hooks-system");

    if (blocked) {
      const reason = matched
        .filter((h) => h.action === "block")
        .map((h) => h.message)
        .filter(Boolean)
        .join("; ");
      return { block: true, reason: reason || "Blocked by hooks-system pre_tool_use hook" };
    }
  });

  // ── tool_result: Process post_tool_use hooks ─────────────────────────────

  pi.on("tool_result", async (event, ctx) => {
    const config = loadConfigFor(ctx);

    const toolName = event.toolName;
    const input = event.input;

    const matched = matchHooks(config.hooks, "post_tool_use", toolName, input, {
      isError: event.isError,
    });
    const { injectMessages } = await executeHooks(matched, pi, ctx, { toolName, input });

    // Inject feedback messages (e.g., exec failures with onFailure: "inject")
    injectSteerMessages(pi, injectMessages, "hooks-system-feedback");
  });

  // ── agent_end: Process agent_end hooks (formerly documented as stop_request) ─

  pi.on("agent_end", (_event, ctx) => {
    const config = loadConfigFor(ctx);

    const matched = matchHooks(config.hooks, "agent_end");

    // Warn about hooks whose action is not supported on agent_end. Only
    // `inject` fires here (as a triggerTurn); block/warn/exec are silently
    // ignored, so surface them.
    const unsupported = matched.filter((h) => h.action !== "inject");
    if (unsupported.length > 0) {
      const actions = [...new Set(unsupported.map((h) => h.action))].join(", ");
      ctx.ui.notify(
        `hooks-system: ${unsupported.length} agent_end hook(s) use unsupported action(s) (${actions}); only "inject" fires on agent_end`,
        "warning",
      );
    }

    // Merge all matching inject hooks into one message (previously only the
    // first was kept, silently dropping the rest).
    const prompts = matched
      .filter((h) => h.action === "inject" && h.injectPrompt)
      .map((h) => h.injectPrompt!);

    if (prompts.length > 0) {
      injectTriggerTurn(pi, "hooks-stop-check", prompts.join("\n\n"));
    }
  });
}
