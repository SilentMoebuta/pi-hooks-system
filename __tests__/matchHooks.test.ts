import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchHooks, renderCommandTemplate, buildHookVariables } from "../index";
import type { HookDefinition } from "../index";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("matchHooks", () => {
  // 1. Empty hooks array returns empty
  it("returns empty array when hooks array is empty", () => {
    const result = matchHooks([], "pre_tool_use", "bash", { command: "ls" });
    assert.deepStrictEqual(result, []);
  });

  // 2. Event matching: only hooks with matching event are returned
  it("only returns hooks whose event matches the requested event", () => {
    const hooks: HookDefinition[] = [
      { event: "pre_tool_use", action: "block" },
      { event: "post_tool_use", action: "warn" },
      { event: "agent_end", action: "inject", injectPrompt: "stop" },
      { event: "session_start", action: "inject", injectPrompt: "hello" },
    ];
    const result = matchHooks(hooks, "pre_tool_use");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].event, "pre_tool_use");
    assert.strictEqual(result[0].action, "block");
  });

  // 3. Tool name matching: matcher.tool filters by tool name
  it("filters hooks by matcher.tool when provided", () => {
    const hooks: HookDefinition[] = [
      { event: "pre_tool_use", matcher: { tool: "bash" }, action: "block" },
      { event: "pre_tool_use", matcher: { tool: "write" }, action: "warn" },
      { event: "pre_tool_use", action: "inject", injectPrompt: "no-matcher" },
    ];

    // Only hooks with tool "bash" or no tool matcher should match
    const result = matchHooks(hooks, "pre_tool_use", "bash");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].matcher?.tool, "bash");
    // The third hook has no matcher, so it should also match
    assert.strictEqual(result[1].action, "inject");
  });

  // 4. Pattern matching: matcher.pattern regex against serialized input
  it("filters hooks by matcher.pattern tested against JSON-serialized input", () => {
    const hooks: HookDefinition[] = [
      { event: "pre_tool_use", matcher: { pattern: "rm\\s" }, action: "block" },
      { event: "pre_tool_use", matcher: { pattern: "ls" }, action: "warn" },
      { event: "pre_tool_use", matcher: { pattern: "cat" }, action: "inject", injectPrompt: "p" },
    ];

    // "rm -rf /" should match the first pattern
    const result = matchHooks(hooks, "pre_tool_use", "bash", { command: "rm -rf /" });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].matcher?.pattern, "rm\\s");
  });

  // 5. ReDoS protection: pattern > 200 chars → hook skipped
  it("skips hooks whose matcher.pattern exceeds 200 characters (ReDoS protection)", () => {
    const longPattern = "a".repeat(201);
    const hooks: HookDefinition[] = [
      { event: "pre_tool_use", matcher: { pattern: longPattern }, action: "block" },
      // A normal hook should still match alongside it
      { event: "pre_tool_use", action: "warn" },
    ];
    const result = matchHooks(hooks, "pre_tool_use", "bash", { command: "test" });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, "warn");
  });

  // 6. ReDoS protection: input > 5000 chars → hook skipped
  it("skips hooks when serialized input exceeds 5000 characters (ReDoS protection)", () => {
    // Create input whose JSON representation exceeds 5000 characters
    const longData = "x".repeat(10000);
    const hooks: HookDefinition[] = [
      { event: "pre_tool_use", matcher: { pattern: "x" }, action: "block" },
      // A hook without pattern should still match
      { event: "pre_tool_use", matcher: { tool: "bash" }, action: "warn" },
    ];
    const result = matchHooks(hooks, "pre_tool_use", "bash", { data: longData });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, "warn");
  });

  // 7. Invalid regex in pattern → hook skipped silently
  it("silently skips hooks whose matcher.pattern is an invalid regex", () => {
    const hooks: HookDefinition[] = [
      { event: "pre_tool_use", matcher: { pattern: "[unclosed" }, action: "block" },
      { event: "pre_tool_use", matcher: { pattern: "(?invalid)" }, action: "warn" },
      // Valid hook should still match
      { event: "pre_tool_use", action: "inject", injectPrompt: "ok" },
    ];
    // Should not throw
    const result = matchHooks(hooks, "pre_tool_use", "bash", { command: "test" });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, "inject");
  });

  // 8. No matcher → hook always matches if event matches
  it("matches any hook without a matcher when its event matches", () => {
    const hooks: HookDefinition[] = [
      { event: "pre_tool_use", action: "block" },
      { event: "post_tool_use", action: "warn" },
    ];
    const result = matchHooks(hooks, "pre_tool_use", "any_tool", { any: "input" });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, "block");
  });

  // 9. Multiple hooks matching: all matching hooks returned in order
  it("returns all matching hooks in their original order", () => {
    const hooks: HookDefinition[] = [
      { event: "pre_tool_use", matcher: { tool: "bash" }, action: "block" },
      { event: "pre_tool_use", action: "warn" },
      { event: "pre_tool_use", matcher: { pattern: "." }, action: "inject", injectPrompt: "any" },
      { event: "post_tool_use", action: "exec", command: "true" }, // wrong event
      { event: "session_start", action: "inject", injectPrompt: "start" }, // wrong event
    ];
    const result = matchHooks(hooks, "pre_tool_use", "bash", { command: "ls" });
    assert.strictEqual(result.length, 3);
    assert.deepStrictEqual(result, [hooks[0], hooks[1], hooks[2]]);
  });

  // 10. Input is undefined → serializes to {}
  it("serializes undefined input to {} for pattern matching", () => {
    // Pattern that matches the literal "{}"
    const hooks: HookDefinition[] = [
      { event: "pre_tool_use", matcher: { pattern: "\\{\\}" }, action: "block" },
    ];
    const result = matchHooks(hooks, "pre_tool_use", "bash", undefined);
    assert.strictEqual(result.length, 1);
  });

  // 11. Mixed matcher: both tool AND pattern must match
  it("requires both tool and pattern to match when both matcher fields are present", () => {
    const hooks: HookDefinition[] = [
      { event: "pre_tool_use", matcher: { tool: "bash", pattern: "rm" }, action: "block" },
    ];

    // Both tool and pattern match
    let result = matchHooks(hooks, "pre_tool_use", "bash", { command: "rm file" });
    assert.strictEqual(result.length, 1);

    // Tool matches, pattern doesn't match
    result = matchHooks(hooks, "pre_tool_use", "bash", { command: "ls" });
    assert.strictEqual(result.length, 0);

    // Pattern matches, tool doesn't match
    result = matchHooks(hooks, "pre_tool_use", "write", { command: "rm file" });
    assert.strictEqual(result.length, 0);

    // Neither tool nor pattern matches
    result = matchHooks(hooks, "pre_tool_use", "write", { command: "ls" });
    assert.strictEqual(result.length, 0);
  });

  // 12. Pattern matches against complex nested input objects
  it("matches pattern against deeply nested input objects via JSON serialization", () => {
    const hooks: HookDefinition[] = [
      { event: "pre_tool_use", matcher: { pattern: "sensitive_data" }, action: "block" },
    ];
    const complexInput = {
      top: "ordinary",
      nested: { deep: { secret: "sensitive_data" } },
      list: [1, "two", { inner: "sensitive_data" }],
    };
    const result = matchHooks(hooks, "pre_tool_use", "read", complexInput);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].action, "block");
  });
});

// ── Command template variables ─────────────────────────────────────────────

describe("command template variables", () => {
  it("builds shell-escaped FILES and EDIT_FILE from write/edit path input", () => {
    const vars = buildHookVariables("write", { path: "src/has space.ts" });
    assert.equal(vars.FILES, "'src/has space.ts'");
    assert.equal(vars.EDIT_FILE, "'src/has space.ts'");
  });

  it("renders ${FILES} and ${EDIT_FILE} placeholders", () => {
    const rendered = renderCommandTemplate(
      "npx jest --findRelatedTests ${FILES}; echo ${EDIT_FILE}",
      { FILES: "'src/a.ts'", EDIT_FILE: "'src/a.ts'" },
    );
    assert.equal(rendered, "npx jest --findRelatedTests 'src/a.ts'; echo 'src/a.ts'");
  });

  it("leaves unknown ${VARS} untouched (no replacement)", () => {
    const rendered = renderCommandTemplate("echo ${UNKNOWN} ${FILES}", { FILES: "'x'" });
    assert.equal(rendered, "echo ${UNKNOWN} 'x'");
  });

  it("builds empty FILES when input.path is absent (e.g. bash tool)", () => {
    const vars = buildHookVariables("bash", { command: "ls" });
    assert.equal(vars.FILES, "");
    assert.equal(vars.EDIT_FILE, "");
  });
});

// ── agent_end event (formerly stop_request) ─────────────────────────────

describe("agent_end event matching", () => {
  it("matches hooks with event: agent_end", () => {
    const hooks: HookDefinition[] = [
      { event: "agent_end", action: "inject", injectPrompt: "verify" },
      { event: "pre_tool_use", action: "block" },
    ];
    const result = matchHooks(hooks, "agent_end");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].event, "agent_end");
  });

  it("returns multiple agent_end inject hooks in order (agent_end merges them)", () => {
    const hooks: HookDefinition[] = [
      { event: "agent_end", action: "inject", injectPrompt: "check tests" },
      { event: "agent_end", action: "inject", injectPrompt: "check lint" },
      { event: "agent_end", action: "block" }, // different action, still matched
    ];
    const result = matchHooks(hooks, "agent_end");
    assert.strictEqual(result.length, 3);
    const injects = result.filter((h) => h.action === "inject").map((h) => h.injectPrompt);
    assert.deepStrictEqual(injects, ["check tests", "check lint"]);
  });
});

describe("post_tool_use resultIsError matching", () => {
  it("fires hook when resultIsError=true and tool errored", () => {
    const hooks: HookDefinition[] = [{
      event: "post_tool_use", action: "inject",
      matcher: { tool: "bash", resultIsError: true },
      injectPrompt: "bash failed — check stderr",
    }];
    const matched = matchHooks(hooks, "post_tool_use", "bash", { command: "x" }, { isError: true });
    assert.equal(matched.length, 1);
  });

  it("skips hook when resultIsError=true but tool succeeded", () => {
    const hooks: HookDefinition[] = [{
      event: "post_tool_use", action: "inject",
      matcher: { resultIsError: true },
      injectPrompt: "should not fire",
    }];
    assert.equal(matchHooks(hooks, "post_tool_use", "bash", {}, { isError: false }).length, 0);
  });

  it("fires hook without resultIsError matcher regardless of error state (back-compat)", () => {
    const hooks: HookDefinition[] = [{
      event: "post_tool_use", action: "warn", message: "any result",
    }];
    assert.equal(matchHooks(hooks, "post_tool_use", "bash", {}, { isError: true }).length, 1);
    assert.equal(matchHooks(hooks, "post_tool_use", "bash", {}, { isError: false }).length, 1);
    assert.equal(matchHooks(hooks, "post_tool_use", "bash", {}).length, 1);
  });

  it("resultIsError has no effect on pre_tool_use (no result yet)", () => {
    const hooks: HookDefinition[] = [{
      event: "pre_tool_use", action: "warn",
      matcher: { resultIsError: true },
      message: "x",
    }];
    // pre_tool_use: result is undefined; resultIsError=true && !result?.isError → filtered out
    assert.equal(matchHooks(hooks, "pre_tool_use", "bash", {}).length, 0);
  });
});
