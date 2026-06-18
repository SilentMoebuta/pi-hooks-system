import { describe, it, after } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadHooksConfig } from "../index";

describe("loadHooksConfig", () => {
  const tempDirs: string[] = [];

  // Clean up all temp dirs after all tests
  after(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-test-"));
    tempDirs.push(dir);
    return dir;
  }

  function writeConfig(tempDir: string, content: string): void {
    const piDir = path.join(tempDir, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, "hooks.json"), content, "utf-8");
  }

  // 1. Missing file — directory with no .pi/hooks.json returns { hooks: [] }
  it("should return empty hooks for missing file", () => {
    const tempDir = makeTempDir();
    const result = loadHooksConfig(tempDir);
    assert.deepStrictEqual(result, { hooks: [] });
  });

  // 2. Valid JSON — creates temp dir, writes valid .pi/hooks.json, loads it, verifies hooks array
  it("should load valid JSON and return hooks array", () => {
    const tempDir = makeTempDir();
    const hookDef = {
      event: "pre_tool_use",
      matcher: { tool: "bash", pattern: "rm -rf" },
      action: "block",
      message: "Dangerous command detected",
    };
    writeConfig(tempDir, JSON.stringify({ hooks: [hookDef] }));

    const result = loadHooksConfig(tempDir);
    assert.deepStrictEqual(result, { hooks: [hookDef] });
  });

  // 3. Malformed JSON — invalid JSON → returns { hooks: [] } (no crash)
  it("should return empty hooks for malformed JSON (no crash)", () => {
    const tempDir = makeTempDir();
    writeConfig(tempDir, "not valid json {{{");
    const result = loadHooksConfig(tempDir);
    assert.deepStrictEqual(result, { hooks: [] });
  });

  // 4. Missing hooks key — {} → returns { hooks: [] }
  it("should return empty hooks when object has no hooks key (empty object)", () => {
    const tempDir = makeTempDir();
    writeConfig(tempDir, JSON.stringify({}));
    const result = loadHooksConfig(tempDir);
    assert.deepStrictEqual(result, { hooks: [] });
  });

  // 4b. Missing hooks key — {"other": true} → returns { hooks: [] }
  it("should return empty hooks when object has no hooks key (other keys present)", () => {
    const tempDir = makeTempDir();
    writeConfig(tempDir, JSON.stringify({ other: true }));
    const result = loadHooksConfig(tempDir);
    assert.deepStrictEqual(result, { hooks: [] });
  });

  // 5. Hooks is not an array — {"hooks": "string"} → returns { hooks: [] }
  it("should return empty hooks when hooks value is not an array", () => {
    const tempDir = makeTempDir();
    writeConfig(tempDir, JSON.stringify({ hooks: "string" }));
    const result = loadHooksConfig(tempDir);
    assert.deepStrictEqual(result, { hooks: [] });
  });

  // 6. Empty hooks array — {"hooks": []} → returns empty array
  it("should return empty array for empty hooks array", () => {
    const tempDir = makeTempDir();
    writeConfig(tempDir, JSON.stringify({ hooks: [] }));
    const result = loadHooksConfig(tempDir);
    assert.deepStrictEqual(result, { hooks: [] });
  });
});
