# Myzelium plugin for Claude Code

A private plugin marketplace. Its one plugin, `myzelium`, shows the Claude Code
sessions you run on your own machine (on your own subscription) in Myzelium:
what each one is working on, which branch and files it touches, and which ones
are waiting for you. It shows up on the project's Build workspace, next to the
active-work board.

**Read-only.** The plugin only reports. Myzelium never sends anything into your
session.

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

Needs `bash`, `git` and `curl`.

## What is sent

One small POST per event (`SessionStart`, `UserPromptSubmit`, `Notification`,
`Stop`, `StopFailure`, `SessionEnd`, and a single `PostToolUse` right after a
permission prompt) to `POST /local-sessions/events` (API code: `apps/context-hub-api/src/local-sessions/` in context-hub), carrying:

- Claude Code's hook input for that event
- the repo's `origin` remote (with any credentials stripped), branch and HEAD
- at the end of a turn: the files the branch changes plus uncommitted ones (up to 80 paths)

Server-side, the prompt is cut to 280 characters and the reply to 600, and
pasted blocks are dropped. Prompt, reply and title are **only stored when the
repo belongs to a Myzelium project your key can read**. For any other repo only
the session's state is kept, for your own "needs you" list.

All hooks run in the background, never block the session, and exit 0 on any
error. Kill switch: `MYZELIUM_SESSIONS_DISABLE=1`.

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
