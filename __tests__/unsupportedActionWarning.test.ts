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
