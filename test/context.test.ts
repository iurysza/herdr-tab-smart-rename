import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LIFECYCLE_SUBSCRIPTIONS,
  normalizeHerdrEvent,
  paneLabelUpdate,
  tabProgressBase,
} from "../src/herdr.ts";
import {
  paneSessionMessages,
  recentUserMessages,
  sampledUserMessages,
} from "../src/pi-context.ts";

const user = (text: string): string =>
  JSON.stringify({
    type: "message",
    message: { role: "user", content: [{ type: "text", text }] },
  });

const claudeUser = (text: string): string =>
  JSON.stringify({ type: "user", content: text, timestamp: "2026-09-06T00:00:00Z" });

const claudeNested = (text: string): string =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });

test("Herdr events normalize while subscriptions avoid output spam", () => {
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
  assert.equal(normalizeHerdrEvent({ id: "response" }), null);
  const paneUpdated = normalizeHerdrEvent({
    event: "pane.updated",
    data: {
      type: "pane_updated",
      pane: {
        pane_id: "p1",
        workspace_id: "w1",
        tab_id: "t1",
        focused: true,
        agent_status: "working",
        revision: 42,
        label: "Review Auth",
      },
    },
  });
  assert.ok(paneUpdated);
  assert.deepEqual(paneLabelUpdate(paneUpdated), {
    paneId: "p1",
    label: "Review Auth",
  });

  const subscriptions: readonly string[] = LIFECYCLE_SUBSCRIPTIONS;
  assert.ok(subscriptions.includes("tab.renamed"));
  assert.ok(subscriptions.includes("pane.updated"));
  assert.equal(subscriptions.includes("pane.renamed"), false);
  assert.equal(subscriptions.includes("pane.output_matched"), false);
  assert.equal(tabProgressBase("\u2063◆ Review Auth"), "Review Auth");
  assert.equal(tabProgressBase("◆ Review Auth"), null);
});

test("Pi session sampling weights origin, midpoint, and recent requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-samples-"));
  const agentDir = path.join(root, "agent");
  const sessions = path.join(agentDir, "sessions", "project");
  const session = path.join(sessions, "session.jsonl");
  await mkdir(sessions, { recursive: true });
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
    assert.deepEqual(
      await sampledUserMessages(session, {
        ...process.env,
        HOME: root,
        PI_CODING_AGENT_DIR: agentDir,
      }),
      {
        origin: ["Build automatic tab naming"],
        middle: ["Fix manual ownership"],
        recent: [
          "Recent request 2",
          "Recent request 3",
          "Recent request 4",
          "Recent request 5",
        ],
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi session reads stay bounded to regular files under the sessions root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-session-"));
  const agentDir = path.join(root, "agent");
  const sessions = path.join(agentDir, "sessions", "project");
  const session = path.join(sessions, "session.jsonl");
  const outside = path.join(root, "outside.jsonl");
  await mkdir(sessions, { recursive: true });
  await writeFile(session, `${"x".repeat(600_000)}\n${user("Fix socket reconnect")}\n`);
  await writeFile(outside, `${user("Do not read this")}\n`);
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

async function claudeHome() {
  const root = await mkdtemp(path.join(os.tmpdir(), "tab-smart-rename-claude-"));
  const claudeDir = path.join(root, ".claude");
  const transcripts = path.join(claudeDir, "transcripts");
  const projects = path.join(claudeDir, "projects", "repo");
  await mkdir(transcripts, { recursive: true });
  await mkdir(projects, { recursive: true });
  return {
    root,
    claudeDir,
    transcripts,
    projects,
    env: {
      ...process.env,
      HOME: root,
      CLAUDE_CONFIG_DIR: claudeDir,
    },
  };
}

test("Claude path reads stay inside transcripts or projects", async () => {
  const fixture = await claudeHome();
  const allowed = path.join(fixture.transcripts, "ses_allowed.jsonl");
  const outside = path.join(fixture.root, "outside.jsonl");
  await writeFile(allowed, `${claudeUser("Fix theme config")}\n`);
  await writeFile(outside, `${claudeUser("Do not read this")}\n`);
  try {
    assert.deepEqual(
      await sampledUserMessages(allowed, fixture.env, [
        fixture.transcripts,
        path.join(fixture.claudeDir, "projects"),
      ]),
      {
        origin: ["Fix theme config"],
        middle: [],
        recent: [],
      },
    );
    assert.deepEqual(
      await sampledUserMessages(outside, fixture.env, [
        fixture.transcripts,
        path.join(fixture.claudeDir, "projects"),
      ]),
      { origin: [], middle: [], recent: [] },
    );
    assert.deepEqual(
      await recentUserMessages(allowed, 6, {
        ...fixture.env,
        PI_CODING_AGENT_DIR: path.join(fixture.root, "agent"),
      }),
      [],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Claude session ids resolve uniquely without cwd slugs", async () => {
  const fixture = await claudeHome();
  const id = "ses_2b55f846fffeJh07PLHtISYIPE";
  await writeFile(
    path.join(fixture.transcripts, `${id}.jsonl`),
    `${claudeUser("Rename from transcript id")}\n`,
  );
  await writeFile(
    path.join(fixture.projects, "uuid-session.jsonl"),
    `${claudeNested("Rename from project file")}\n`,
  );
  try {
    assert.deepEqual(
      await paneSessionMessages(
        {
          agent: "claude",
          agent_session: { kind: "id", value: id },
        },
        fixture.env,
      ),
      {
        origin: ["Rename from transcript id"],
        middle: [],
        recent: [],
      },
    );
    assert.deepEqual(
      await paneSessionMessages(
        {
          agent: "claude",
          agent_session: {
            kind: "id",
            value: "uuid-session",
          },
        },
        fixture.env,
      ),
      {
        origin: ["Rename from project file"],
        middle: [],
        recent: [],
      },
    );
    assert.deepEqual(
      await paneSessionMessages(
        {
          agent: "claude",
          agent_session: { kind: "id", value: "../outside" },
        },
        fixture.env,
      ),
      { origin: [], middle: [], recent: [] },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("duplicate Claude project matches are skipped", async () => {
  const fixture = await claudeHome();
  const other = path.join(fixture.claudeDir, "projects", "other");
  await mkdir(other, { recursive: true });
  await writeFile(
    path.join(fixture.projects, "dup.jsonl"),
    `${claudeUser("First copy")}\n`,
  );
  await writeFile(
    path.join(other, "dup.jsonl"),
    `${claudeUser("Second copy")}\n`,
  );
  try {
    assert.deepEqual(
      await paneSessionMessages(
        {
          agent: "claude",
          agent_session: { kind: "id", value: "dup" },
        },
        fixture.env,
      ),
      { origin: [], middle: [], recent: [] },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Claude extraction keeps user text and drops wrappers", async () => {
  const fixture = await claudeHome();
  const session = path.join(fixture.transcripts, "ses_noise.jsonl");
  await writeFile(
    session,
    [
      JSON.stringify({ type: "tool_use", name: "bash" }),
      JSON.stringify({
        type: "user",
        isMeta: true,
        content: "Injected style",
      }),
      JSON.stringify({
        type: "user",
        isSidechain: true,
        content: "Subagent task",
      }),
      claudeUser("<command-name>/model</command-name>"),
      claudeUser("[Request interrupted by user]"),
      claudeUser("[No response requested]"),
      claudeUser(
        "<system-reminder>hidden</system-reminder>Fix theme config",
      ),
      claudeNested("Review auth changes"),
      "",
    ].join("\n"),
  );
  try {
    assert.deepEqual(
      await paneSessionMessages(
        {
          agent: "claude",
          agent_session: { kind: "path", value: session },
        },
        fixture.env,
      ),
      {
        origin: ["Fix theme config"],
        middle: ["Review auth changes"],
        recent: [],
      },
    );
    const wrappers = path.join(fixture.transcripts, "ses_empty.jsonl");
    await writeFile(
      wrappers,
      `${claudeUser("<command-message>model</command-message>")}\n`,
    );
    assert.deepEqual(
      await paneSessionMessages(
        {
          agent: "claude",
          agent_session: { kind: "id", value: "ses_empty" },
        },
        fixture.env,
      ),
      { origin: [], middle: [], recent: [] },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
