# omp-plugin-coop

Pair two [omp](https://github.com/oh-my-pi/omp) coding-agent sessions into an automated handoff loop.

Two interactive omp instances (for example: one building a library, one integrating and testing it) exchange work items through markdown handoff files. When a session finishes its work, it writes its handoff; the peer's watcher notices the file and **wakes the idle session with the handoff as its next prompt** — no supervisor scripts, no headless runs, and approval prompts stay visible in the TUI.

```
 pane 1 (omp A)                        pane 2 (omp B)
 /coop start  ── prints join cmd ──▶   /coop join <id>
      │                                     │
      │ write abcd2efgh.md (tmp + mv)       │
      ├─────────── handoff ────────────────▶│ wake + prompt
      │◀─────────── handoff ────────────────┤ write efgh2abcd.md
```

## How it works

- `/coop start` generates a **pairing id**: 8 characters, 4 for each side (`abcdefgh` → you are `abcd`, the peer is `efgh`). It prints the exact command to run in the other session: `/coop join abcdefgh`.
- Each side watches one file in the sync dir and owns the opposite one:
  - `<me>2<peer>.md` — **outgoing**: write your handoff here when done (write to the path with a `.tmp` suffix, then `mv` it over the final name so the peer sees it atomically).
  - `<peer>2<me>.md` — **incoming**: the watcher polls this file; when it has content and your session is idle, it is consumed and delivered as an agent-attributed prompt.
- A 5-second tick checks the incoming file. It never interrupts a running turn and never double-delivers: the file is removed before delivery, and if delivery fails the content is restored.
- The injected handoff message carries the protocol footer, so the peer learns the reply convention in-session.
- On pairing, the extension queues a **protocol briefing** into the paired session: injected at the next step boundary if the agent is mid-task, or with its next prompt if idle. That is what teaches the agent to write its outgoing handoff as the final action of its current work — no handoff file exists until an agent actually finishes something.

## Commands

| Command | Effect |
| --- | --- |
| `/coop start` | Generate a pairing id, start watching; **clears my outgoing file**; prints the `/coop join` command for the peer |
| `/coop join <id>` | Join as the second half of the id; **clears my outgoing file** |
| `/coop pause` | Stop waking on incoming handoffs (the incoming file is kept and delivered on resume) |
| `/coop resume` | Resume waking |
| `/coop drop` | End coop; **clears my incoming file** |

Pairing state is persisted in session entries, so it survives `/resume`; a fresh session starts unpaired.

## Install

**A. Drop-in (simplest):** copy (or symlink) the extension into your omp extensions directory and restart the session:

```sh
ln -s "$PWD/src/coop.ts" ~/.omp/agent/extensions/coop.ts
```

**B. Marketplace:** omp reads the same catalog format as Claude Code plugin registries:

```
/marketplace add <you>/omp-plugin-coop
/marketplace install coop@omp-plugin-coop
```

**C. Ad-hoc:** launch with `omp -e ./src/coop.ts`.

Extension modules load at session start — `/reload-plugins` does not pick them up; use `/restart` or relaunch.

## Handoff protocol

A handoff is free-form markdown — the work order for the peer. For a library/integration pair, a handoff typically names the branch or commit to pull, the GitHub issue ids to fix or verify, and the acceptance checks. The only convention the plugin enforces is delivery: write the file last, atomically:

```sh
printf '...' > ~/.omp/plugin-coop/abcd2efgh.md.tmp && mv ~/.omp/plugin-coop/abcd2efgh.md.tmp ~/.omp/plugin-coop/abcd2efgh.md
```

Roles and project knowledge (repos, issue trackers, checks to run) belong in each repo's `AGENTS.md` — the plugin stays generic.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `COOP_DIR` | `~/.omp/plugin-coop` | Sync directory for handoff files |

## Development

```
npm test        # node --test test/ (Node >= 24 runs the TS directly)
```

The tests exercise the extension through a structural mock of the used `ExtensionAPI` slice: pairing, clearing rules, pause/resume/drop semantics, the watcher tick (wake, busy deferral, paused hold, empty placeholder, restore-on-failed-delivery), state rebuild from session entries, and argument completion.

The `import type { ExtensionAPI }` in the source is erased at runtime — the extension needs no npm dependencies, it runs inside the omp host.

## Scope and limits

- Both sessions must share the same `COOP_DIR` (same machine, or a shared mount).
- One watcher per process: the main session owns it, subagents never consume handoffs.
- The watcher wakes the session only when it is idle with an empty prompt queue; it will not steer a turn in flight.
