// Tests for the coop extension. Runs under node --test (Node >= 24 type stripping).
// setup-env.ts is imported first on purpose: it must set COOP_DIR before the
// extension module is evaluated.
// The extension keeps pairing state in module-level variables, so tests rely on
// in-file declaration order: negative cases first, then tests that pair via
// start/join. Each test sets its own pairing state before asserting.
import { describe, test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { testDir } from "./setup-env.ts";
import coopFactory from "../src/coop.ts";

// ---- stubs for the used ExtensionAPI slice ---------------------------------

interface NotifyCall {
  message: string;
  type?: string;
}

interface CompletionItem {
  label: string;
  value: string;
  description: string;
}

interface CommandContextStub {
  ui: { notify: (message: string, type?: string) => void };
  isIdle: () => boolean;
}

interface CommandDescriptor {
  description?: string;
  handler: (args: string, ctx: CommandContextStub) => Promise<void> | void;
  getArgumentCompletions?: (prefix: string) => CompletionItem[] | null;
}

type EventHandler = (event: unknown, ctx: unknown) => Promise<void> | void;

interface SessionContextStub {
  sessionManager: { getBranch: () => readonly unknown[] };
  isIdle: () => boolean;
  hasPendingMessages: () => boolean;
  setInterval: (fn: () => void, ms: number) => unknown; // mock: captures the callback, never schedules
}

interface SentMessage {
  text: string;
  options: { attribution?: string; deliverAs?: string };
}

interface ExtensionApiStub {
  on: (event: string, handler: EventHandler) => void;
  registerCommand: (name: string, descriptor: CommandDescriptor) => void;
  sendMessage: (
    message: { customType: string; content: string; display?: boolean; attribution?: string },
    options: { deliverAs?: string; triggerTurn?: boolean },
  ) => void;
  sendUserMessage: (text: string, options: SentMessage["options"]) => void;
  logger: { error?: (msg: string) => void; debug?: (msg: string) => void };
}

// ---- mock state (dynamic registries, populated at runtime) -----------------

const handlers = new Map<string, EventHandler[]>();
const commands = new Map<string, CommandDescriptor>();
let appended: Array<{ type: string; data: unknown }> = [];
let sent: SentMessage[] = [];
let briefings: Array<{ message: { customType: string; content: string }; options: { deliverAs?: string } }> = [];
let notifies: NotifyCall[] = [];
let failNextSend = false;
let idle = true;
let pendingMessages = false;
let tickCb: (() => void) | null = null;
let branchEntries: readonly unknown[] = [];

const pi: ExtensionApiStub = {
  on(event, handler) {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  },
  registerCommand(name, descriptor) {
    commands.set(name, descriptor);
  },
  appendEntry(type, data) {
    appended.push({ type, data });
  },
  sendUserMessage(text, options) {
    if (failNextSend) {
      failNextSend = false;
      throw new Error("delivery failed");
    }
    sent.push({ text, options });
  },
  sendMessage(message, options) {
    briefings.push({
      message: { customType: message.customType, content: message.content },
      options,
    });
  },
  logger: {},
};

const sessionCtx: SessionContextStub = {
  sessionManager: { getBranch: () => branchEntries },
  isIdle: () => idle,
  hasPendingMessages: () => pendingMessages,
  setInterval(fn) {
    tickCb = fn;
    return 1;
  },
};

const emitSessionStart = async (): Promise<void> => {
  for (const handler of handlers.get("session_start") ?? []) {
    await handler({}, sessionCtx);
  }
};

const runCommand = async (args: string): Promise<void> => {
  const descriptor = commands.get("coop");
  assert.ok(descriptor, "coop command should be registered");
  await descriptor.handler(args, {
    ui: { notify: (message, type) => notifies.push({ message, type }) },
    isIdle: () => idle,
  });
};

interface PairingView {
  me: string;
  peer: string;
  paused: boolean;
  active: boolean;
}

const latestPairing = (): PairingView => {
  const last = appended.at(-1);
  assert.ok(last, "expected a persisted coop.state entry");
  return last.data as PairingView;
};

const pairingAfter = async (command: string): Promise<PairingView> => {
  const before = appended.length;
  await runCommand(command);
  assert.ok(appended.length > before, `expected state append for: ${command}`);
  return latestPairing();
};

const inboxPath = (peer: string, me: string): string => join(testDir, `${peer}2${me}.md`);
const outgoingPath = (me: string, peer: string): string => join(testDir, `${me}2${peer}.md`);

// ---- suite -----------------------------------------------------------------

before(async () => {
  // test double: structurally implements the ExtensionAPI slice the plugin uses
  coopFactory(pi as unknown as Parameters<typeof coopFactory>[0]);
  await emitSessionStart(); // captures the watcher tick callback
  assert.ok(tickCb, "watcher tick should be scheduled");
});

beforeEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  appended = [];
  sent = [];
  briefings = [];
  notifies = [];
  failNextSend = false;
  idle = true;
  pendingMessages = false;
});

describe("commands before pairing", () => {
  test("pause/resume/drop warn when coop is not active", async () => {
    await runCommand("pause");
    await runCommand("resume");
    await runCommand("drop");
    assert.ok(notifies.every((n) => n.type === "warning"));
    assert.equal(appended.length, 0);
  });
});

describe("argument completions", () => {
  test("empty prefix lists all subcommands", () => {
    const items = commands.get("coop")?.getArgumentCompletions?.("");
    assert.ok(items);
    assert.deepEqual(
      items.map((i) => i.label),
      ["start", "join", "pause", "resume", "drop"],
    );
    assert.ok(items.every((i) => i.value.length > 0 && i.description.length > 0));
  });

  test("prefix filters, unknown prefix and id input yield null", () => {
    const desc = commands.get("coop")?.getArgumentCompletions;
    assert.ok(desc);
    assert.deepEqual(desc("st")?.map((i) => i.label), ["start"]);
    assert.deepEqual(desc("join")?.map((i) => i.label), ["join"]);
    assert.equal(desc("zzz"), null);
    assert.equal(desc("join "), null); // typing the pairing id
  });
});

describe("pairing", () => {
  test("start generates a valid 8-char id and prints the join command", async () => {
    const st = await pairingAfter("start");
    assert.match(st.me, /^[a-z0-9]{4}$/);
    assert.match(st.peer, /^[a-z0-9]{4}$/);
    assert.equal(st.active, true);
    assert.equal(st.paused, false);
    assert.equal(appended[0].type, "coop.state");
    assert.ok(
      notifies.some((n) => n.message.includes(`/coop join ${st.me}${st.peer}`)),
    );
  });
  test("pairing queues a protocol briefing for the idle agent", async () => {
    const st = await pairingAfter("start");
    assert.equal(briefings.length, 1);
    assert.equal(briefings[0].message.customType, "coop.briefing");
    assert.match(briefings[0].message.content, /FINAL action/);
    assert.ok(briefings[0].message.content.includes(outgoingPath(st.me, st.peer)));
    assert.equal(briefings[0].options.deliverAs, "nextTurn"); // paired while idle
  });

  test("pairing while busy queues the briefing as aside", async () => {
    idle = false;
    await pairingAfter("start");
    assert.equal(briefings.length, 1);
    assert.equal(briefings[0].options.deliverAs, "aside");
  });
  test("join pairs as the second half and clears only my outgoing file", async () => {
    writeFileSync(join(testDir, "efgh2abcd.md"), "stale outgoing");
    writeFileSync(join(testDir, "abcd2efgh.md"), "pending incoming");
    const st = await pairingAfter("join abcdefgh");
    assert.equal(st.me, "efgh");
    assert.equal(st.peer, "abcd");
    assert.equal(existsSync(join(testDir, "efgh2abcd.md")), false, "outgoing cleared");
    assert.equal(existsSync(join(testDir, "abcd2efgh.md")), true, "incoming kept");
    assert.ok(notifies.some((n) => n.message.includes("joined")));
  });

  test("join uppercases are normalized", async () => {
    const st = await pairingAfter("join ABCDEFGH");
    assert.equal(st.me, "efgh");
    assert.equal(st.peer, "abcd");
  });

  test("join rejects malformed ids without persisting state", async () => {
    const before = appended.length;
    await runCommand("join abc");
    await runCommand("join abcdefghij");
    await runCommand("join abc3efgh1"); // '1' not in the lookalike-free alphabet
    assert.equal(appended.length, before);
    assert.ok(notifies.every((n) => n.type === "warning"));
    assert.ok(notifies.some((n) => n.message.includes("usage")));
  });

  test("unknown subcommand prints usage", async () => {
    await runCommand("frobnicate");
    assert.ok(notifies.some((n) => n.message.includes("usage")));
    assert.equal(appended.length, 0);
  });
});

describe("pause / resume / drop", () => {
  test("pause flags state and resume clears it", async () => {
    await runCommand("start");
    await runCommand("pause");
    assert.equal(latestPairing().paused, true);
    await runCommand("resume");
    assert.equal(latestPairing().paused, false);
  });

  test("drop clears my incoming file and deactivates", async () => {
    const st = await pairingAfter("start");
    writeFileSync(inboxPath(st.peer, st.me), "pending handoff");
    await runCommand("drop");
    assert.equal(existsSync(inboxPath(st.peer, st.me)), false, "incoming cleared");
    assert.equal(latestPairing().active, false);
  });
});

describe("watcher tick", () => {
  test("wakes an idle session and consumes the handoff", async () => {
    const st = await pairingAfter("start");
    writeFileSync(inboxPath(st.peer, st.me), "please do X");
    tickCb?.();
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /please do X/);
    assert.match(sent[0].text, /coop protocol/);
    assert.match(sent[0].text, /FINAL action/);
    assert.ok(sent[0].text.includes(outgoingPath(st.me, st.peer)));
    assert.equal(sent[0].options.attribution, "agent");
    assert.equal(existsSync(inboxPath(st.peer, st.me)), false, "handoff consumed");
  });

  test("defers while busy or while messages are queued", async () => {
    const st = await pairingAfter("start");
    const inbox = inboxPath(st.peer, st.me);
    writeFileSync(inbox, "work item");
    idle = false;
    tickCb?.();
    assert.equal(sent.length, 0);
    assert.equal(existsSync(inbox), true);
    idle = true;
    pendingMessages = true;
    tickCb?.();
    assert.equal(sent.length, 0);
    assert.equal(existsSync(inbox), true);
    pendingMessages = false;
    tickCb?.();
    assert.equal(sent.length, 1);
    assert.equal(existsSync(inbox), false);
  });

  test("holds while paused, delivers after resume", async () => {
    const st = await pairingAfter("start");
    await runCommand("pause");
    const inbox = inboxPath(st.peer, st.me);
    writeFileSync(inbox, "queued work");
    tickCb?.();
    assert.equal(sent.length, 0);
    assert.equal(existsSync(inbox), true);
    await runCommand("resume");
    tickCb?.();
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /queued work/);
  });

  test("ignores an empty placeholder file", async () => {
    const st = await pairingAfter("start");
    const inbox = inboxPath(st.peer, st.me);
    writeFileSync(inbox, "  \n\t");
    tickCb?.();
    assert.equal(sent.length, 0);
    assert.equal(existsSync(inbox), true, "placeholder untouched");
  });

  test("restores the handoff when delivery fails", async () => {
    const st = await pairingAfter("start");
    const inbox = inboxPath(st.peer, st.me);
    writeFileSync(inbox, "restore me");
    failNextSend = true;
    tickCb?.();
    assert.equal(sent.length, 0);
    assert.equal(existsSync(inbox), true);
    assert.equal(readFileSync(inbox, "utf8"), "restore me\n");
  });
});

describe("state rebuild from session entries", () => {
  test("restores pairing from a persisted coop.state entry", async () => {
    branchEntries = [
      {
        type: "custom",
        customType: "coop.state",
        data: { me: "aaaa", peer: "bbbb", paused: false, active: true },
      },
    ];
    await emitSessionStart();
    writeFileSync(join(testDir, "bbbb2aaaa.md"), "pending handoff");
    await runCommand("drop");
    assert.equal(existsSync(join(testDir, "bbbb2aaaa.md")), false, "cleared by drop");
    assert.equal(latestPairing().active, false);
  });

  test("accepts the custom_message entry variant too", async () => {
    branchEntries = [
      {
        type: "custom_message",
        customType: "coop.state",
        data: { me: "cccc", peer: "dddd", paused: false, active: true },
      },
    ];
    await emitSessionStart();
    writeFileSync(join(testDir, "dddd2cccc.md"), "pending handoff");
    await runCommand("drop");
    assert.equal(existsSync(join(testDir, "dddd2cccc.md")), false, "cleared by drop");
  });
});
