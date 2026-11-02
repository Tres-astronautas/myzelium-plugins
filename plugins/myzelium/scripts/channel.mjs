#!/usr/bin/env node
// Myzelium channel. Delivers the answers you type in Myzelium's inbox (web or
// phone) into this Claude Code session, between turns, as if you had typed
// them here — and relays permission prompts, so you can allow or deny one
// tool call from Myzelium while the terminal dialog stays open too.
//
// An MCP server over stdio, with no dependencies (Node 18+). It does nothing
// unless the session was started with the channel on:
//
//   claude --dangerously-load-development-channels plugin:myzelium@myzelium
//
// (or `--channels plugin:myzelium@myzelium` once your org allowlists it).
// Without that flag Claude Code drops channel events silently, so the server
// does not even poll: an answer it claimed would be lost, and Myzelium only
// offers an answer box for a session whose channel is polling.
//
// Only the session's owner can send one: the API takes answers from the
// owner's signed-in account, and this server fetches them with the owner's
// MCP key. Kill switch: MYZELIUM_SESSIONS_DISABLE=1.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KEY = process.env.MYZELIUM_API_KEY || '';
const API = (process.env.MYZELIUM_API_URL || 'https://api.myzelium.ai').replace(/\/+$/, '');
const DATA = process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'myzelium');
const POLL_MS = 3000;

const INSTRUCTIONS = [
  'Events in a <channel> tag from the Myzelium channel are messages from your user,',
  'typed in Myzelium (their web or phone inbox) in reply to what you last said or asked in this session.',
  'Only the signed-in owner of this session can send one, and they arrive only between turns.',
  'Treat each exactly as if the user had typed it in this terminal: it is their next instruction.',
].join(' ');

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/** The claude process's own command line: this server is its direct child. */
function parentArgs() {
  try {
    const proc = `/proc/${process.ppid}/cmdline`;
    if (fs.existsSync(proc)) return fs.readFileSync(proc, 'utf8').split('\0').filter(Boolean);
    return execFileSync('ps', ['-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim().split(/\s+/);
  } catch {
    return [];
  }
}

/** True when the session was started with this plugin named as a channel. */
export function channelOn(args) {
  const flags = new Set(['--channels', '--dangerously-load-development-channels']);
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (!flags.has(flag)) continue;
    const values = inline !== undefined ? [inline] : [];
    for (let j = i + 1; j < args.length && !args[j].startsWith('-'); j++) values.push(args[j]);
    if (values.join(' ').split(/[\s,]+/).some((v) => v.startsWith('plugin:myzelium@'))) return true;
  }
  return false;
}

/**
 * The session this process serves. The hooks keep `by-pid/<claude pid>`
 * current, so /clear and --resume (new session id, same process) follow;
 * the environment only knows the id the process started with.
 */
function sessionId() {
  try {
    const sid = fs.readFileSync(path.join(DATA, 'by-pid', String(process.ppid)), 'utf8').trim();
    if (sid) return sid;
  } catch {
    /* no hook has run yet */
  }
  return process.env.CLAUDE_CODE_SESSION_ID || '';
}

let polling = false;
let stopped = false;

async function poll() {
  if (stopped) return;
  const sid = sessionId();
  if (sid) {
    try {
      const res = await fetch(`${API}/local-sessions/channel?session=${encodeURIComponent(sid)}`, {
        headers: { Authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      // A key that is wrong stays wrong: stop asking instead of hammering.
      if (res.status === 401 || res.status === 403) {
        stopped = true;
        return;
      }
      if (res.ok) {
        const { messages = [], verdicts = [] } = await res.json();
        // A verdict applies only to a prompt Claude Code issued with that id;
        // it never reaches the model as text.
        for (const v of verdicts) {
          if (!/^[a-km-z]{5}$/.test(v.request_id) || (v.behavior !== 'allow' && v.behavior !== 'deny')) continue;
          write({
            jsonrpc: '2.0',
            method: 'notifications/claude/channel/permission',
            params: { request_id: v.request_id, behavior: v.behavior },
          });
        }
        for (const m of messages) {
          write({
            jsonrpc: '2.0',
            method: 'notifications/claude/channel',
            params: { content: String(m.body), meta: { from: String(m.from || 'you'), message_id: String(m.id) } },
          });
        }
      }
    } catch {
      /* offline or the API is down: try again next tick */
    }
  }
  setTimeout(poll, POLL_MS);
}

/** A permission prompt opened: tell Myzelium, so its owner can decide it there. */
async function relayPermission(params) {
  const sid = sessionId();
  if (!polling || stopped || !sid) return;
  try {
    await fetch(`${API}/local-sessions/channel/permission`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: sid,
        request_id: String(params.request_id ?? ''),
        tool_name: String(params.tool_name ?? ''),
        description: String(params.description ?? ''),
        input_preview: String(params.input_preview ?? ''),
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* the terminal dialog is still open: nothing is lost */
  }
}

function startPolling() {
  if (polling || !KEY || process.env.MYZELIUM_SESSIONS_DISABLE || !channelOn(parentArgs())) return;
  polling = true;
  void poll();
}

function handle(msg) {
  if (msg.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        // The relay is safe to declare: a verdict only ever comes from the
        // session's owner, signed in to Myzelium (the API checks it).
        capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} } },
        serverInfo: { name: 'myzelium', version: '0.5.0' },
        instructions: INSTRUCTIONS,
      },
    });
    return;
  }
  if (msg.method === 'notifications/initialized') {
    startPolling();
    return;
  }
  if (msg.method === 'notifications/claude/channel/permission_request') {
    void relayPermission(msg.params ?? {});
    return;
  }
  if (msg.id === undefined) return; // other notifications: nothing to do
  if (msg.method === 'ping') write({ jsonrpc: '2.0', id: msg.id, result: {} });
  else write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
}

// Run as a server only when executed, not when imported by the selftest.
const isMain = (() => {
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1] ?? '');
  } catch {
    return false;
  }
})();

if (isMain) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        /* not JSON-RPC: ignore */
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
