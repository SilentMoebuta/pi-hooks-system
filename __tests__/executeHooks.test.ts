import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeHooks, mergeModifyInstruction } from "../index";
import type { HookDefinition } from "../index";

// ── Minimal fakes ───────────────────────────────────────────────────────────

interface FakeOpts {
  trusted?: boolean;
  hasUI?: boolean;
  /** stdout returned by the fake pi.exec (default "" = no instruction). */
  execStdout?: string;
}

function makeFakes(opts: FakeOpts = {}) {
  const execCalls: { cmd: string; args: string[] }[] = [];
  const notifies: { msg: string; level: string }[] = [];
  const confirms: { title: string; message: string }[] = [];

  const pi: any = {
    exec: async (cmd: string, args: string[]) => {
      execCalls.push({ cmd, args });
      return { code: 0, stdout: opts.execStdout ?? "", stderr: "", killed: false };
    },
    sendMessage: () => {},
  };

  const ctx: any = {
    hasUI: opts.hasUI ?? false,
    signal: undefined,
    isProjectTrusted: () => opts.trusted ?? true,
    ui: {
      notify: (msg: string, level: string) => notifies.push({ msg, level }),
      confirm: async (title: string, message: string) => {
        confirms.push({ title, message });
        return false;
      },
    },
  };

  return { pi, ctx, execCalls, notifies, confirms };
}

// ── Fix 1: exec hooks run only when project is trusted ─────────────────────

describe("executeHooks exec trust gate", () => {
  const execHook: HookDefinition = {
    event: "pre_tool_use",
    action: "exec",
    command: "echo ${FILES}",
  };

  it("runs the exec command when the project IS trusted", async () => {
    const { pi, ctx, execCalls } = makeFakes({ trusted: true });
    await executeHooks([execHook], pi, ctx, { toolName: "write", input: { path: "/tmp/x" } });
    assert.equal(execCalls.length, 1, "exec should run when trusted");
  });

  it("skips the exec command AND notifies when the project is NOT trusted", async () => {
    const { pi, ctx, execCalls, notifies } = makeFakes({ trusted: false });
    await executeHooks([execHook], pi, ctx, { toolName: "write", input: { path: "/tmp/x" } });
    assert.equal(execCalls.length, 0, "exec must NOT run when untrusted");
    assert.ok(
      notifies.some((n) => /not trusted/.test(n.msg)),
      `expected a 'not trusted' warning, got: ${JSON.stringify(notifies)}`,
    );
  });

  it("does not crash when isProjectTrusted is absent (defaults to trusted)", async () => {
    // Some contexts may not implement isProjectTrusted; default to trusted
    // rather than throwing, to preserve prior behavior.
    const pi: any = { exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }), sendMessage: () => {} };
    const ctx: any = {
      hasUI: false,
      signal: undefined,
      ui: { notify: () => {}, confirm: async () => false },
    };
    await executeHooks([execHook], pi, ctx, { toolName: "write", input: { path: "/tmp/x" } });
    // No throw == pass
    assert.ok(true);
  });
});

// ── Fix 3: block always notifies (non-interactive mode) ─────────────────────

describe("executeHooks block notifies regardless of hasUI", () => {
  const blockHook: HookDefinition = {
    event: "pre_tool_use",
    action: "block",
    message: "Dangerous command detected",
  };

  it("notifies the block reason in non-interactive mode (!hasUI)", async () => {
    const { pi, ctx, notifies } = makeFakes({ hasUI: false });
    const res = await executeHooks([blockHook], pi, ctx, {});
    assert.equal(res.blocked, true);
    assert.ok(
      notifies.some((n) => /Dangerous command detected/.test(n.msg)),
      `expected block reason notify, got: ${JSON.stringify(notifies)}`,
    );
  });

  it("uses a generic reason when block hook has no message", async () => {
    const { pi, ctx, notifies } = makeFakes({ hasUI: false });
    await executeHooks([{ event: "pre_tool_use", action: "block" }], pi, ctx, {});
    assert.ok(
      notifies.some((n) => /Blocked by hooks-system/.test(n.msg)),
      `expected generic block notify, got: ${JSON.stringify(notifies)}`,
    );
  });
});

// ── Modify instruction collection (exec stdout → modifyInstruction) ────────

describe("executeHooks modify instruction collection", () => {
  const patchHook: HookDefinition = {
    event: "tool_call" as any,
    action: "exec",
    command: "echo '{\"patch\":{\"input\":{\"command\":\"echo safe\"}}}'",
  };

  it("collects a patch.input instruction from exec stdout on tool_call", async () => {
    const { pi, ctx } = makeFakes({ execStdout: '{"patch":{"input":{"command":"echo safe"}}}' });
    const res = await executeHooks([patchHook], pi, ctx, { toolName: "bash", input: { command: "rm -rf /" } });
    assert.deepEqual(res.modifyInstruction, { patch: { input: { command: "echo safe" } } });
  });

  it("collects a block instruction from exec stdout", async () => {
    const hook: HookDefinition = { event: "tool_call" as any, action: "exec", command: "echo x" };
    const { pi, ctx } = makeFakes({ execStdout: '{"block":true,"reason":"dangerous"}' });
    const res = await executeHooks([hook], pi, ctx, { toolName: "bash" });
    assert.deepEqual(res.modifyInstruction, { block: true, reason: "dangerous" });
  });

  it("collects a replaceResult instruction from exec stdout (tool_result)", async () => {
    const hook: HookDefinition = { event: "tool_result" as any, action: "exec", command: "echo x" };
    const { pi, ctx } = makeFakes({ execStdout: '{"replaceResult":{"isError":false}}' });
    const res = await executeHooks([hook], pi, ctx, { toolName: "bash" });
    assert.deepEqual(res.modifyInstruction, { replaceResult: { isError: false } });
  });

  it("collects a replaceMessage instruction from exec stdout (message_end)", async () => {
    const hook: HookDefinition = { event: "message_end" as any, action: "exec", command: "echo x" };
    const { pi, ctx } = makeFakes({ execStdout: '{"replaceMessage":{"message":{"role":"assistant","content":"x"}}}' });
    const res = await executeHooks([hook], pi, ctx, {});
    assert.deepEqual(res.modifyInstruction, { replaceMessage: { message: { role: "assistant", content: "x" } } });
  });

  it("returns null modifyInstruction when exec stdout is plain text (back-compat)", async () => {
    const hook: HookDefinition = { event: "tool_call" as any, action: "exec", command: "echo x" };
    const { pi, ctx } = makeFakes({ execStdout: "just a log line" });
    const res = await executeHooks([hook], pi, ctx, { toolName: "bash" });
    assert.equal(res.modifyInstruction, null);
  });

  it("returns null modifyInstruction when no exec hook matched", async () => {
    const hook: HookDefinition = { event: "tool_call" as any, action: "warn", message: "hi" };
    const { pi, ctx } = makeFakes();
    const res = await executeHooks([hook], pi, ctx, { toolName: "bash" });
    assert.equal(res.modifyInstruction, null);
  });
});

// ── mergeModifyInstruction (pure) ───────────────────────────────────────────

describe("mergeModifyInstruction", () => {
  it("returns next as-is when acc is null", () => {
    assert.deepEqual(mergeModifyInstruction(null, { block: true, reason: "x" }), { block: true, reason: "x" });
  });

  it("shallow-merges patch.input (later wins on conflict)", () => {
    const acc = { patch: { input: { a: 1, b: 2 } } };
    const next = { patch: { input: { b: 99, c: 3 } } };
    assert.deepEqual(mergeModifyInstruction(acc, next), { patch: { input: { a: 1, b: 99, c: 3 } } });
  });

  it("block is OR-ed; reason keeps first set", () => {
    const acc = { block: true, reason: "first" };
    const next = { block: true };
    assert.deepEqual(mergeModifyInstruction(acc, next), { block: true, reason: "first" });
  });

  it("replaceMessage is last-wins", () => {
    const acc = { replaceMessage: { message: { v: 1 } } };
    const next = { replaceMessage: { message: { v: 2 } } };
    assert.deepEqual(mergeModifyInstruction(acc, next), { replaceMessage: { message: { v: 2 } } });
  });
});
