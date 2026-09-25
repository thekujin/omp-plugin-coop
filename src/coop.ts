// coop — two-instance handoff loop between omp sessions.
//
//   /coop start            generate a pairing id (4+4 chars); you are the first half;
//                          prints "/coop join <id>" to run in the peer session
//   /coop join <id>        join as the second half of the pairing id
//   /coop pause            stop waking on incoming handoffs (file kept)
//   /coop resume           resume waking
//   /coop drop             stop coop; clears my incoming file
//
// Sync dir: ~/.omp/plugin-coop
//   outgoing: <me>2<peer>.md   — I write my handoff here when done (tmp + mv)
//   incoming: <peer>2<me>.md   — peer's handoff; watcher wakes the idle session with it
//
// Example: /coop start generates id "abcdefgh" — A is "abcd", B is "efgh";
// files abcd2efgh.md and efgh2abcd.md.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

interface CoopState {
  me: string;
  peer: string;
  paused: boolean;
  active: boolean;
}

/** Structural slice of the extension context the watcher needs. */
interface IdleView {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
}

const DIR = process.env.COOP_DIR ?? join(homedir(), ".omp", "plugin-coop");
const POLL_MS = 5000;
const ENTRY_TYPE = "coop.state";
const HALF = 4; // pairing id = 4 chars for me + 4 chars for the peer
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/i/l lookalikes

let state: CoopState | null = null;
let watchCtx: IdleView | null = null; // captured from the session that owns the watcher
let watchStarted = false; // one watcher per process; the main session's session_start wins

const coopFile = (from: string, to: string) => join(DIR, `${from}2${to}.md`);

const clearFile = (path: string) => {
  try {
    rmSync(path);
  } catch {
    /* already absent */
  }
};

const genId = (): string =>
  Array.from({ length: 2 * HALF }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("");

const ID_RE = new RegExp(`^[${ID_ALPHABET}]{${2 * HALF}}$`);

function isCoopState(value: unknown): value is CoopState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<CoopState>; // shape check below; no external trust needed
  return (
    typeof v.me === "string" &&
    typeof v.peer === "string" &&
    typeof v.paused === "boolean" &&
    typeof v.active === "boolean"
  );
}

function tick(pi: ExtensionAPI): void {
  try {
    if (!state?.active || state.paused || !watchCtx) return;
    const inbox = coopFile(state.peer, state.me);
    if (!existsSync(inbox)) return;
    const content = readFileSync(inbox, "utf8").trim();
    if (!content) return; // empty placeholder: not a handoff yet
    // Never interrupt a running turn or steal a queued one; retry on the next tick.
    if (!watchCtx.isIdle() || watchCtx.hasPendingMessages()) return;
    rmSync(inbox); // consume first so a later tick cannot re-deliver the same handoff
    const footer =
      `\n\n---\n(coop protocol: your FINAL action must be writing your handoff for ` +
      `${state.peer} to ${coopFile(state.me, state.peer)} — write to that path with a ` +
      `.tmp suffix, then mv it over the final name so the peer sees it atomically. ` +
      `The handoff tells the peer what to do next. Leave the file absent or empty ` +
      `while you work. /coop pause, /coop resume, /coop drop.)`;
    try {
      pi.sendUserMessage(`coop handoff from ${state.peer}:\n\n${content}${footer}`, {
        attribution: "agent",
      });
    } catch (err) {
      writeFileSync(inbox, content + "\n"); // delivery failed: put the handoff back
      pi.logger?.error?.(`coop: sendUserMessage failed, handoff restored: ${err}`);
    }
  } catch (err) {
    pi.logger?.error?.(`coop tick: ${err}`);
  }
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    // Rebuild state from persisted entries (survives resume; fresh session = coop off).
    try {
      const branch: readonly unknown[] = ctx.sessionManager?.getBranch?.() ?? [];
      for (const entry of branch) {
        const e = entry as { type?: unknown; customType?: unknown; data?: unknown } | null;
        if (
          e !== null &&
          typeof e === "object" &&
          (e.type === "custom" || e.type === "custom_message") &&
          e.customType === ENTRY_TYPE &&
          isCoopState(e.data)
        ) {
          state = e.data;
        }
      }
    } catch (err) {
      pi.logger?.error?.(`coop rebuild: ${err}`);
    }
    if (!watchStarted) {
      watchStarted = true;
      watchCtx = ctx;
      ctx.setInterval(() => tick(pi), POLL_MS);
    }
    pi.logger?.debug?.(
      `coop: session loaded (pairing: ${
        state?.active
          ? `${state.me} <-> ${state.peer}${state.paused ? ", paused" : ""}`
          : "none"
      })`,
    );
  });

  pi.registerCommand("coop", {
    description: "Cross-session handoff loop: /coop start | join <id> | pause | resume | drop",
    getArgumentCompletions(prefix) {
      const raw = prefix ?? "";
      if (raw.includes(" ")) return null; // typing a join id — nothing to offer
      const p = raw.trim().toLowerCase();
      const items = [
        {
          label: "start",
          value: "start",
          description: "Generate pairing id; prints the /coop join command for the peer",
        },
        { label: "join", value: "join", description: "Join with the id printed by the peer" },
        { label: "pause", value: "pause", description: "Stop waking on handoffs (file kept)" },
        { label: "resume", value: "resume", description: "Resume waking on handoffs" },
        { label: "drop", value: "drop", description: "End coop; clears my incoming file" },
      ];
      const filtered = items.filter((i) => i.label.startsWith(p));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const [cmd, id] = args.trim().split(/\s+/);
      const pair = (me: string, peer: string, note: string) => {
        mkdirSync(DIR, { recursive: true });
        state = { me, peer, paused: false, active: true };
        pi.appendEntry(ENTRY_TYPE, state);
        clearFile(coopFile(me, peer)); // starting/joining coop clears my outgoing file
        // The paired agent must learn the protocol even if it is mid-task right now:
        // busy -> inject at the next step boundary; idle -> deliver with the next prompt.
        const busy = typeof ctx.isIdle === "function" ? !ctx.isIdle() : false;
        pi.sendMessage(
          {
            customType: "coop.briefing",
            content:
              `coop briefing: you are paired with peer ${peer}. When you finish your current ` +
              `work, your FINAL action must be writing your handoff message for ${peer} to ` +
              `${coopFile(me, peer)}: write to that path with a .tmp suffix, then mv it over ` +
              `the final name. The handoff tells the peer what to do next (branch or commit ` +
              `to pull, issue ids, checks to run). Leave the file absent or empty until you ` +
              `are done. /coop pause, /coop resume and /coop drop control the loop.`,
            display: true,
            attribution: "agent",
          },
          { deliverAs: busy ? "aside" : "nextTurn" },
        );
        pi.logger?.debug?.(`coop paired: ${me} -> ${peer} (briefing: ${busy ? "aside" : "nextTurn"})`);
        ctx.ui.notify(note, "info");
      };
      if (cmd === "start") {
        const newId = genId();
        const me = newId.slice(0, HALF);
        const peer = newId.slice(HALF);
        pair(me, peer, `coop started — you are ${me}, peer is ${peer}. In the other agent run: /coop join ${newId}`);
        return;
      }
      if (cmd === "join") {
        const joined = (id ?? "").toLowerCase();
        if (!ID_RE.test(joined)) {
          ctx.ui.notify(`usage: /coop join <${2 * HALF}-char id printed by the peer>`, "warning");
          return;
        }
        const me = joined.slice(HALF);
        const peer = joined.slice(0, HALF);
        pair(me, peer, `coop joined — you are ${me}, peer is ${peer}`);
        return;
      }
      if (cmd === "pause") {
        if (!state?.active) {
          ctx.ui.notify("coop: run /coop start first", "warning");
          return;
        }
        state = { ...state, paused: true };
        pi.appendEntry(ENTRY_TYPE, state);
        ctx.ui.notify(`coop paused (incoming ${coopFile(state.peer, state.me)} is kept)`, "info");
        return;
      }
      if (cmd === "resume") {
        if (!state?.active) {
          ctx.ui.notify("coop: run /coop start first", "warning");
          return;
        }
        state = { ...state, paused: false };
        pi.appendEntry(ENTRY_TYPE, state);
        ctx.ui.notify("coop resumed", "info");
        return;
      }
      if (cmd === "drop") {
        if (!state) {
          ctx.ui.notify("coop: nothing to drop", "warning");
          return;
        }
        state = { ...state, active: false };
        pi.appendEntry(ENTRY_TYPE, state);
        clearFile(coopFile(state.peer, state.me)); // ending coop clears my incoming file
        ctx.ui.notify(`coop dropped; cleared ${coopFile(state.peer, state.me)}`, "info");
        return;
      }
      ctx.ui.notify("usage: /coop start | join <id> | pause | resume | drop", "warning");
    },
  });
}
