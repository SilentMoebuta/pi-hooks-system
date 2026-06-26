import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import hooksExtension from "../index";

// ── Fake pi + ctx harness ──────────────────────────────────────────────────

function makeHarness(cwd: string) {
  const handlers: Record<string, ((event: any, ctx: any) => any) | undefined> = {};
  const notifies: { msg: string; level: string }[] = [];
  const sentMessages: any[] = [];
  const appendEntries: { type: string; data: any }[] = [];

  const pi: any = {
    on: (event: string, fn: (event: any, ctx: any) => any) => {
      handlers[event] = fn;
    },
    appendEntry: (type: string, data: any) => appendEntries.push({ type, data }),
    sendMessage: (msg: any) => sentMessages.push(msg),
  };

  const ctx: any = {
    cwd,
    hasUI: true,
    signal: undefined,
    isProjectTrusted: () => true,
    ui: {
      notify: (msg: string, level: string) => notifies.push({ msg, level }),
      confirm: async () => false,
    },
    sessionManager: { getCurrentSessionId: () => "s1" },
  };

  return { pi, ctx, handlers, notifies, sentMessages, appendEntries };
}

// ── Fix 2: session_start / agent_end warn on unsupported actions ───────────

describe("session_start / agent_end unsupported-action warnings", () => {
  const tempDirs: string[] = [];
  before(() => {});
  after(() => {
    for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-warn-"));
    tempDirs.push(dir);
    return dir;
  }

  function writeConfig(tempDir: string, hooks: any[]): void {
    const piDir = path.join(tempDir, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, "hooks.json"), JSON.stringify({ hooks }), "utf-8");
  }

  it("session_start warns when a hook uses a non-inject action (e.g. exec)", async () => {
    const dir = makeTempDir();
    writeConfig(dir, [
      { event: "session_start", action: "exec", command: "echo hi" },
      { event: "session_start", action: "inject", injectPrompt: "hello" },
    ]);
    const { pi, ctx, handlers, notifies, sentMessages } = makeHarness(dir);
    hooksExtension(pi);
    await handlers.session_start!({}, ctx);
    assert.ok(
      notifies.some((n) => /unsupported action/.test(n.msg) && /exec/.test(n.msg)),
      `expected unsupported-action warning for exec, got: ${JSON.stringify(notifies)}`,
    );
    // The inject hook still fires
    assert.equal(sentMessages.length, 1, "inject prompt should still be sent");
  });

  it("session_start does NOT warn when all hooks use inject", async () => {
    const dir = makeTempDir();
    writeConfig(dir, [
      { event: "session_start", action: "inject", injectPrompt: "a" },
      { event: "session_start", action: "inject", injectPrompt: "b" },
    ]);
    const { pi, ctx, handlers, notifies } = makeHarness(dir);
    hooksExtension(pi);
    await handlers.session_start!({}, ctx);
    assert.ok(
      !notifies.some((n) => /unsupported action/.test(n.msg)),
      `no unsupported-action warning expected, got: ${JSON.stringify(notifies)}`,
    );
  });

  it("agent_end warns when a hook uses a non-inject action (e.g. block)", async () => {
    const dir = makeTempDir();
    writeConfig(dir, [
      { event: "agent_end", action: "block", message: "nope" },
      { event: "agent_end", action: "inject", injectPrompt: "verify" },
    ]);
    const { pi, ctx, handlers, notifies, sentMessages } = makeHarness(dir);
    hooksExtension(pi);
    await handlers.agent_end!({}, ctx);
    assert.ok(
      notifies.some((n) => /unsupported action/.test(n.msg) && /block/.test(n.msg)),
      `expected unsupported-action warning for block, got: ${JSON.stringify(notifies)}`,
    );
    // inject hook fires as a triggerTurn
    assert.equal(sentMessages.length, 1);
  });
});

// ── Modify capability end-to-end (subscription layer translation) ──────────

describe("modify capability translation at subscription layer", () => {
  const tempDirs: string[] = [];
  after(() => { for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true }); });

  function makeConfigured(hooks: any[]): { pi: any; ctx: any; handlers: any } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-mod-"));
    tempDirs.push(dir);
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".pi", "hooks.json"), JSON.stringify({ hooks }));
    const h = makeHarness(dir);
    // give pi.exec so exec hooks can run, returning a fixed stdout
    h.pi.exec = async () => ({ code: 0, stdout: (h as any)._execStdout ?? "", stderr: "", killed: false });
    hooksExtension(h.pi);
    return h;
  }

  it("tool_call: patch.input is merged into event.input (mutates args before execution)", async () => {
    const h = makeConfigured([
      { event: "tool_call", matcher: { tool: "bash" }, action: "exec", command: "echo x" },
    ]);
    (h as any)._execStdout = '{"patch":{"input":{"command":"echo safe"}}}';
    const event = { toolName: "bash", input: { command: "rm -rf /" } };
    const ret = await h.handlers["tool_call"]!(event, h.ctx);
    // input was mutated in place (pi-core contract: mutate event.input)
    assert.equal((event.input as any).command, "echo safe", "input patched to safe command");
    assert.equal(ret, undefined, "no block → no return value");
  });

  it("tool_call: block instruction returns {block:true,reason}", async () => {
    const h = makeConfigured([
      { event: "tool_call", matcher: { tool: "bash" }, action: "exec", command: "echo x" },
    ]);
    (h as any)._execStdout = '{"block":true,"reason":"dangerous"}';
    const event = { toolName: "bash", input: { command: "x" } };
    const ret = await h.handlers["tool_call"]!(event, h.ctx);
    assert.deepEqual(ret, { block: true, reason: "dangerous" });
  });

  it("tool_result: replaceResult returns partial patch (omitted fields omitted)", async () => {
    const h = makeConfigured([
      { event: "tool_result", matcher: { tool: "bash" }, action: "exec", command: "echo x" },
    ]);
    (h as any)._execStdout = '{"replaceResult":{"isError":false}}';
    const event = { toolName: "bash", input: {}, isError: true, content: [] };
    const ret = await h.handlers["tool_result"]!(event, h.ctx);
    assert.deepEqual(ret, { isError: false }, "partial patch: only isError returned");
  });

  it("message_end: replaceMessage returns {message}", async () => {
    const h = makeConfigured([
      { event: "message_end", action: "exec", command: "echo x" },
    ]);
    (h as any)._execStdout = '{"replaceMessage":{"message":{"role":"assistant","content":"redacted"}}}';
    const ret = await h.handlers["message_end"]!({}, h.ctx);
    assert.deepEqual(ret, { message: { role: "assistant", content: "redacted" } });
  });

  it("legacy CC name pre_tool_use config still fires on tool_call subscription (dual-name)", async () => {
    // old config uses pre_tool_use; subscription arrives as tool_call. Both
    // normalize to tool_call → hook fires.
    const h = makeConfigured([
      { event: "pre_tool_use", matcher: { tool: "bash" }, action: "exec", command: "echo x" },
    ]);
    (h as any)._execStdout = '{"block":true,"reason":"legacy"}';
    const event = { toolName: "bash", input: { command: "x" } };
    const ret = await h.handlers["tool_call"]!(event, h.ctx);
    assert.deepEqual(ret, { block: true, reason: "legacy" });
  });
});
