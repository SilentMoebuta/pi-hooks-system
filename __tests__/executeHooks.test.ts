import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeHooks } from "../index";
import type { HookDefinition } from "../index";

// ── Minimal fakes ───────────────────────────────────────────────────────────

interface FakeOpts {
  trusted?: boolean;
  hasUI?: boolean;
}

function makeFakes(opts: FakeOpts = {}) {
  const execCalls: { cmd: string; args: string[] }[] = [];
  const notifies: { msg: string; level: string }[] = [];
  const confirms: { title: string; message: string }[] = [];

  const pi: any = {
    exec: async (cmd: string, args: string[]) => {
      execCalls.push({ cmd, args });
      return { code: 0, stdout: "", stderr: "", killed: false };
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
