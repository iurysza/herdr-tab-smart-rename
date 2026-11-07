import { test } from "bun:test";
import assert from "node:assert/strict";
import { isNativeRegistryConnect, nativeE2eSandbox } from "../scripts/verify-native-e2e.ts";

test("native integration defaults to no network, private writes and no real launchctl", () => {
  const profile = nativeE2eSandbox("/private/fixture", "/Users/fixture");
  assert.match(profile, /\(deny network\*\)/);
  assert.doesNotMatch(profile, /allow network-outbound/);
  assert.match(profile, /deny process-exec \(literal "\/bin\/launchctl"\)/);
  assert.match(profile, /deny file-read\* \(subpath "\/Users\/fixture"\)/);
  assert.match(profile, /allow file-write\* \(subpath "\/private\/fixture"\)/);
  assert.match(profile, /deny file-read\* \(literal "\/dev\/tty"\)/);
});

test("only the dependency actor policy permits its localhost registry tunnel", () => {
  const profile = nativeE2eSandbox("/private/fixture", "/Users/fixture", 43210);
  assert.match(profile, /remote ip "localhost:43210"/);
  assert.doesNotMatch(profile, /remote ip "\*:443"|remote ip "\*:53"/);
  assert.throws(() => nativeE2eSandbox("/private/fixture", "/Users/fixture", 0));
  assert.throws(() => nativeE2eSandbox("/private/fixture", "/Users/fixture", 65536));
});

test("registry tunnel refuses provider hosts, redirects, other ports and absolute request URLs", () => {
  assert.equal(isNativeRegistryConnect("CONNECT registry.npmjs.org:443 HTTP/1.1"), true);
  assert.equal(isNativeRegistryConnect("CONNECT registry.npmjs.org:443 HTTP/1.0"), true);

  for (const request of [
    "CONNECT api.openai.com:443 HTTP/1.1",
    "CONNECT registry.npmjs.org.evil:443 HTTP/1.1",
    "CONNECT registry.npmjs.org:80 HTTP/1.1",
    "GET https://registry.npmjs.org/package HTTP/1.1",
  ]) assert.equal(isNativeRegistryConnect(request), false);
});
