// node plugins/myzelium/scripts/channel.selftest.mjs — the flag detection that
// decides whether the channel server polls at all.
import assert from 'node:assert/strict';
import { channelOn } from './channel.mjs';

const on = (s) => channelOn(s.split(' '));
assert.equal(on('claude --dangerously-load-development-channels plugin:myzelium@myzelium'), true);
assert.equal(on('claude --channels plugin:telegram@claude-plugins-official plugin:myzelium@myzelium'), true);
assert.equal(on('claude --channels=plugin:myzelium@myzelium --remote-control'), true);
assert.equal(on('claude --resume abc'), false, 'no flag: the server never polls');
assert.equal(on('claude --channels plugin:telegram@claude-plugins-official --model opus plugin:myzelium@myzelium'), false,
  'a later positional is the prompt, not a channel');
assert.equal(on('claude --dangerously-load-development-channels server:webhook'), false, 'another channel only');
console.log('channel selftest: ok');
