import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeEvent,
  CC_TO_PI_EVENT,
  DEPRECATED_CC_EVENTS,
  PI_HOOK_EVENTS,
  type PiHookEvent,
} from "../index";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("event normalization (CC → pi dual-name compatibility)", () => {
  it("maps legacy CC event names to pi-native names", () => {
    assert.equal(normalizeEvent("pre_tool_use"), "tool_call");
    assert.equal(normalizeEvent("post_tool_use"), "tool_result");
  });

  it("passes through pi-native names unchanged", () => {
    assert.equal(normalizeEvent("tool_call"), "tool_call");
    assert.equal(normalizeEvent("tool_result"), "tool_result");
    assert.equal(normalizeEvent("message_end"), "message_end");
  });

  it("passes through same-named events (agent_end, session_start)", () => {
    assert.equal(normalizeEvent("agent_end"), "agent_end");
    assert.equal(normalizeEvent("session_start"), "session_start");
  });

  it("CC_TO_PI_EVENT maps all legacy CC names", () => {
    assert.deepEqual(Object.keys(CC_TO_PI_EVENT).sort(), [
      "agent_end",
      "post_tool_use",
      "pre_tool_use",
      "session_start",
    ]);
    assert.equal(CC_TO_PI_EVENT["pre_tool_use"], "tool_call");
    assert.equal(CC_TO_PI_EVENT["post_tool_use"], "tool_result");
  });

  it("DEPRECATED_CC_EVENTS flags only the renamed CC names (not same-named)", () => {
    // pre_tool_use / post_tool_use were renamed → deprecated alias
    assert.ok(DEPRECATED_CC_EVENTS.has("pre_tool_use"));
    assert.ok(DEPRECATED_CC_EVENTS.has("post_tool_use"));
    // agent_end / session_start kept their names → not deprecated aliases
    assert.ok(!DEPRECATED_CC_EVENTS.has("agent_end"));
    assert.ok(!DEPRECATED_CC_EVENTS.has("session_start"));
  });
});

describe("PI_HOOK_EVENTS (full pi-core event list for forwarding)", () => {
  it("includes all lifecycle events", () => {
    for (const e of [
      "session_start", "session_shutdown", "session_before_switch",
      "session_before_fork", "session_before_compact", "session_compact",
      "session_before_tree", "session_tree",
    ] as const) {
      assert.ok(PI_HOOK_EVENTS.includes(e), `missing lifecycle event: ${e}`);
    }
  });

  it("includes all agent/turn events", () => {
    for (const e of [
      "before_agent_start", "agent_start", "agent_end", "turn_start", "turn_end",
    ] as const) {
      assert.ok(PI_HOOK_EVENTS.includes(e), `missing agent/turn event: ${e}`);
    }
  });

  it("includes all message events", () => {
    for (const e of ["message_start", "message_update", "message_end"] as const) {
      assert.ok(PI_HOOK_EVENTS.includes(e), `missing message event: ${e}`);
    }
  });

  it("includes all tool events", () => {
    for (const e of [
      "tool_call", "tool_result", "tool_execution_start",
      "tool_execution_update", "tool_execution_end",
    ] as const) {
      assert.ok(PI_HOOK_EVENTS.includes(e), `missing tool event: ${e}`);
    }
  });

  it("includes provider and user-input events", () => {
    for (const e of [
      "before_provider_request", "after_provider_response",
      "model_select", "thinking_level_select", "user_bash", "input",
    ] as const) {
      assert.ok(PI_HOOK_EVENTS.includes(e), `missing event: ${e}`);
    }
  });

  it("does NOT include discovery/internal events (project_trust, resources_discover, context)", () => {
    // these are not suitable for external shell hooks (discovery / internal state)
    assert.ok(!PI_HOOK_EVENTS.includes("project_trust" as PiHookEvent));
    assert.ok(!PI_HOOK_EVENTS.includes("resources_discover" as PiHookEvent));
    assert.ok(!PI_HOOK_EVENTS.includes("context" as PiHookEvent));
  });
});
