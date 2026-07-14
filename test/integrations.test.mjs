import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LIFECYCLE_SUBSCRIPTIONS,
  normalizeHerdrEvent,
} from "../src/integrations.mjs";
import {
  recentUserMessages,
  sampledUserMessages,
} from "../src/pi-sessions.mjs";

test("Herdr event envelopes normalize top-level event and data", () => {
  assert.deepEqual(
    normalizeHerdrEvent({
      event: "tab.renamed",
      data: { type: "tab_renamed", tab_id: "t1", label: "Build API" },
    }),
    {
      eventName: "tab.renamed",
      type: "tab_renamed",
      tab_id: "t1",
      label: "Build API",
    },
  );
  assert.equal(
    normalizeHerdrEvent({
      event: "pane.agent_status_changed",
      data: { pane_id: "p1", agent_status: "working" },
    }).type,
    "pane_agent_status_changed",
  );
  assert.equal(normalizeHerdrEvent({ id: "response" }), null);
});

test("subscriptions avoid catch-all output matching", () => {
  assert.equal(LIFECYCLE_SUBSCRIPTIONS.includes("tab.renamed"), true);
  assert.equal(LIFECYCLE_SUBSCRIPTIONS.includes("pane.output_matched"), false);
});

test("session sampler weights origin midpoint and recent requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoname-samples-"));
  const agentDir = path.join(root, "agent");
  const sessions = path.join(agentDir, "sessions", "project");
  await mkdir(sessions, { recursive: true });
  const session = path.join(sessions, "session.jsonl");
  const user = (text) =>
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text }] },
    });
  await writeFile(
    session,
    [
      user("Build automatic tab naming"),
      "x".repeat(400_000),
      user("Fix manual ownership"),
      "x".repeat(400_000),
      ...Array.from({ length: 5 }, (_, index) => user(`Recent request ${index + 1}`)),
      "",
    ].join("\n"),
  );

  try {
    const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir };
    assert.deepEqual(await sampledUserMessages(session, env), {
      origin: ["Build automatic tab naming"],
      middle: ["Fix manual ownership"],
      recent: [
        "Recent request 2",
        "Recent request 3",
        "Recent request 4",
        "Recent request 5",
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session reader accepts only bounded regular Pi session tails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoname-session-"));
  const agentDir = path.join(root, "agent");
  const sessions = path.join(agentDir, "sessions", "project");
  const outside = path.join(root, "outside.jsonl");
  await mkdir(sessions, { recursive: true });
  const session = path.join(sessions, "session.jsonl");
  const user = JSON.stringify({
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "Fix socket reconnect" }] },
  });
  await writeFile(session, `${"x".repeat(600_000)}\n${user}\n`);
  await writeFile(outside, `${user}\n`);

  try {
    const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir };
    assert.deepEqual(await recentUserMessages(session, 6, env), [
      "Fix socket reconnect",
    ]);
    assert.deepEqual(await recentUserMessages(outside, 6, env), []);
    assert.deepEqual(await recentUserMessages(root, 6, env), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
