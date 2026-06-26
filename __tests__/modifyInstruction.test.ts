import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModifyInstruction } from "../index";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("parseModifyInstruction (hook stdout → modify instruction)", () => {
  it("parses a tool_call input patch instruction", () => {
    const out = parseModifyInstruction('{"patch":{"input":{"command":"echo safe"}}}');
    assert.deepEqual(out, { patch: { input: { command: "echo safe" } } });
  });

  it("parses a tool_call block instruction", () => {
    const out = parseModifyInstruction('{"block":true,"reason":"dangerous command"}');
    assert.deepEqual(out, { block: true, reason: "dangerous command" });
  });

  it("parses a tool_result replace instruction (partial patch)", () => {
    const out = parseModifyInstruction('{"replaceResult":{"isError":false}}');
    assert.deepEqual(out, { replaceResult: { isError: false } });
  });

  it("parses a message_end replace instruction", () => {
    const out = parseModifyInstruction('{"replaceMessage":{"message":{"role":"assistant","content":"redacted"}}}');
    assert.deepEqual(out, {
      replaceMessage: { message: { role: "assistant", content: "redacted" } },
    });
  });

  it("returns null for non-JSON stdout (back-compat: treated as inject text)", () => {
    assert.equal(parseModifyInstruction("just some log output\n"), null);
    assert.equal(parseModifyInstruction(""), null);
  });

  it("returns null for JSON without any modify-instruction field", () => {
    // valid JSON but no patch/block/replaceResult/replaceMessage → not a
    // modify instruction, treat as plain text (back-compat with exec hooks
    // that happen to print JSON to stdout).
    assert.equal(parseModifyInstruction('{"status":"ok","count":3}'), null);
    assert.equal(parseModifyInstruction('[1,2,3]'), null);
  });

  it("returns null for malformed JSON (does not throw)", () => {
    assert.equal(parseModifyInstruction('{"patch": {input: broken}'), null);
    assert.equal(parseModifyInstruction("{not json"), null);
  });

  it("trims leading/trailing whitespace before parsing", () => {
    const out = parseModifyInstruction('  \n  {"block":true,"reason":"x"}  \n  ');
    assert.deepEqual(out, { block: true, reason: "x" });
  });

  it("handles a patch instruction with block reason omitted (block true, no reason)", () => {
    const out = parseModifyInstruction('{"block":true}');
    assert.deepEqual(out, { block: true });
  });
});
