import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolveSocketPath } from "../src/herdr.ts";

test("resolveSocketPath leaves POSIX socket paths untouched", () => {
  assert.equal(
    resolveSocketPath("/tmp/herdr/herdr.sock", "linux"),
    "/tmp/herdr/herdr.sock",
  );
  assert.equal(
    resolveSocketPath("/tmp/herdr/herdr.sock", "darwin"),
    "/tmp/herdr/herdr.sock",
  );
});

test("resolveSocketPath prefixes Windows socket paths with the pipe namespace", () => {
  assert.equal(
    resolveSocketPath("C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock", "win32"),
    "\\\\.\\pipe\\C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock",
  );
});

test("resolveSocketPath does not double-prefix an already-resolved pipe path", () => {
  const alreadyResolved = "\\\\.\\pipe\\C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock";
  assert.equal(resolveSocketPath(alreadyResolved, "win32"), alreadyResolved);
});

test("resolveSocketPath accepts the forward-slash Windows pipe alias", () => {
  const forwardSlash = "//./pipe/C:/Users/me/AppData/Roaming/herdr/herdr.sock";
  assert.equal(resolveSocketPath(forwardSlash, "win32"), forwardSlash);
});
