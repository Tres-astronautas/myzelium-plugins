# Myzelium plugin for Claude Code

A private plugin marketplace. Its one plugin, `myzelium`, makes every Claude
Code session you open in a Myzelium project **aware of the other work on that
project**: other people's sessions and your own on other machines, VirtualCoder
runs, and files two sessions are both changing.

When a session starts, it gets a short brief from Myzelium, which Claude Code
adds to the session's context. Claude can then ask for the detail with the
Myzelium MCP tool `get_sibling_sessions`. The audience is Claude, not a
dashboard: Myzelium coordinates sessions, it never steers them. (Seeing and
answering your sessions from your phone is what Claude's Remote Control is for.)

**Privacy.** Work on a Myzelium project is shared with that project's members.
A repo that is not linked to a project your key can read is never stored.

## Install

```
/plugin marketplace add Tres-astronautas/myzelium-plugins
/plugin install myzelium@myzelium
```

The repo is private: your machine needs git access to it already (an SSH key
in `ssh-agent`, or `gh auth login && gh auth setup-git` for HTTPS — set
`CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` if you have no GitHub SSH key). Sessions
already running pick the plugin up after `/reload-plugins` or a restart.

When it is enabled, Claude Code asks for your **Myzelium MCP key** (`chmcp_…`,
Myzelium → Settings → MCP keys). It is stored in your OS credential store, not
in `settings.json`. To try it without installing:
`MYZELIUM_API_KEY=chmcp_… claude --plugin-dir plugins/myzelium`.

Needs `bash`, `git` and `curl` to report; answering also needs `node` 18+.

## What is sent

One small POST per event (`SessionStart`, `UserPromptSubmit`, `Notification`,
`Stop`, `StopFailure`, `SessionEnd`, and a single `PostToolUse` right after a
permission prompt) to `POST /local-sessions/events` (API code: `apps/context-hub-api/src/local-sessions/` in context-hub), carrying:

- Claude Code's hook input for that event
- the repo's `origin` remote (with any credentials stripped), branch and HEAD
- the `projectId` from the nearest `.context-hub/project.json` at or above the
  session's folder, if there is one — the same file the Myzelium MCP binds by.
  It wins over the git remote, and is what links a session started in a folder
  that is not itself a git repo (only if your key can read that project)
- at the end of a turn: the files the branch changes plus uncommitted ones (up to 80 paths)
- whether the session runs under Remote Control (spawned by `claude remote-control`)
  or in a terminal, so its card can say where to answer it

A turn that ends on a question is recorded as waiting on that question, so it
shows up in your home inbox as a decision, not just "finished".

Server-side, the prompt is cut to 280 characters and the reply to 600, and
pasted blocks are dropped. **Nothing is stored unless the repo belongs to a
Myzelium project your key can read** (API 2026-11-10 and later). Everything
stored is visible to that project's members.

`SessionStart` is the one hook that waits: up to 6 seconds (the request itself
gives up after 4) for the brief, which it prints as the hook's
`additionalContext`. It prints nothing when the session is alone in its
project, when the repo is not linked, or on any error, so an older API or an
outage simply means no brief. Every other hook runs in the background. All of
them exit 0 on any error. Kill switch: `MYZELIUM_SESSIONS_DISABLE=1`.

## Answering from Myzelium

Start Claude Code with the channel on:

```
claude --dangerously-load-development-channels plugin:myzelium@myzelium
```

(`--channels plugin:myzelium@myzelium` once your org adds it to
`allowedChannelPlugins`; Team/Enterprise orgs must also have `channelsEnabled`
on — Organization settings → Claude Code → Channels.)

Then a session that asks you something, or finishes its turn, shows an answer
box in Myzelium's inbox. What you type is delivered by `scripts/channel.mjs`, a
small MCP server Claude Code runs inside the session:

- **Only you** can answer your session — the answer is taken from your signed-in
  Myzelium account, and fetched with your MCP key.
- **Only between turns.** An answer waits while the session is working.
- **The terminal wins.** If you type in the terminal first, the queued answer
  is cancelled, never delivered late.
- **Permission prompts: one call at a time.** When the session stops on a
  permission prompt, the card shows the tool and its arguments with **Allow
  once** and **Deny**. The verdict applies to that call only; the terminal
  dialog stays open, and whichever answer comes first wins. The arguments are
  stored only while the prompt is open, and wiped when it closes.
- Without the flag the channel server does nothing — it does not even poll.

Sessions spawned by `claude remote-control` (the device server) cannot be
started with channels, so they stay read-only; answer them in the Claude app.

## States

| State | Meaning |
|---|---|
| Working | a turn is running |
| Blocked on you | a permission prompt, a question, or a failed turn |
| Your move | the turn finished; it waits for your next message |
| Ended | the session exited (still shown for 2 h) |

A session that has not reported anything for 24 h is hidden.

## Releasing a change

Bump `version` in `plugins/myzelium/.claude-plugin/plugin.json` — users stay on
their cached copy until it changes. Run `claude plugin validate .` first.
