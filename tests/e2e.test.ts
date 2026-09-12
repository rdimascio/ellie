import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { defaults } from '@ellie/config';
import { Client, discoverCertificate, fingerprint } from '@ellie/transport';
import { record, job, CAPABILITIES } from '@ellie/protocol';
import type { Action } from '@ellie/protocol';
import { Auth, newToken } from '../apps/server/src/auth.ts';
import { createEllieServer } from '../apps/server/src/index.ts';
import { runNode } from '../apps/node/src/index.ts';

async function fixture(timeout = 2000) {
  const dir = await mkdtemp(join(tmpdir(), 'ellie-e2e-'));
  const key = execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout','-','-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=ellie.local'], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
  const cert = await readFile(join(dir, 'cert.pem'), 'utf8');
  const token = newToken(); await Auth.initialize(token, dir);
  const auth = await Auth.open(dir);
  const app = createEllieServer({ key, cert, auth, preferences: defaults, commandTimeout: timeout });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const controller = new Client(origin, cert, token); const clients = [controller];
  async function pair(id: string) {
    const invite = record(await controller.call('POST', '/v1/invite', {}));
    const guest = new Client(origin, cert); clients.push(guest);
    const paired = record(await guest.call('POST', '/v1/pair', { id, code: invite.code }));
    const client = new Client(origin, cert, String(paired.token)); clients.push(client);
    return client;
  }
  return { app, origin, cert, controller, pair, async close() { clients.forEach(client => client.close()); app.shutdown(); await rm(dir, { recursive: true, force: true }); } };
}
test('real HTTPS command round trip through node executor with contextual follow-up', async () => {
  const f = await fixture(); const abort = new AbortController();
  const calls: Action[] = []; let agent: Promise<void> | undefined;
  try {
    const node = await f.pair('test-node'); let ready!: () => void;
    const registered = new Promise<void>(resolve => { ready = resolve; });
    agent = runNode({ client: node, preferences: defaults, signal: abort.signal,
      executor: { capabilities: async () => [...CAPABILITIES], execute: async action => { calls.push(action); return { ok: true, message: 'Done.' }; } }, onStatus: () => ready() });
    await registered;
    for (const text of ['Ellie, open Arc', 'put it in the top-left', 'open Netflix', 'move Arc to the big monitor and make it fullscreen', 'put Messages next to it']) {
      assert.equal(record(await node.call('POST', '/v1/commands', { nodeId: 'test-node', text })).ok, true);
    }
    assert.deepEqual(calls.map(action => action.tool), ['app.open','window.place','url.open','window.place','window.adjacent']);
    assert.equal(record(calls[4]).anchor, defaults.browser);
    assert.equal(record(await node.call('POST', '/v1/commands', { nodeId: 'test-node', text: 'delete all files' })).ok, false);
    assert.equal(calls.length, 5);
  } finally { abort.abort(); await f.close(); await agent; }
});
test('wrong fingerprint is rejected before credentials are sent', async () => {
  const f = await fixture(); let requests = 0;
  f.app.server.on('request', () => { requests++; });
  try {
    await assert.rejects(discoverCertificate(f.origin, '00'.repeat(32)), /fingerprint/);
    assert.equal(requests, 0);
    const cert = await discoverCertificate(f.origin, fingerprint(f.cert));
    assert.equal(fingerprint(cert), fingerprint(f.cert));
    assert.equal(requests, 0);
    const stranger = new Client(f.origin, f.cert);
    try { await assert.rejects(stranger.call('GET', '/v1/nodes'), /Authentication/); } finally { stranger.close(); }
  } finally { await f.close(); }
});
test('node credentials cannot control another Mac, issue invites, or spoof its result', async () => {
  const f = await fixture();
  try {
    const a = await f.pair('node-a'); const b = await f.pair('node-b');
    for (const client of [a,b]) await client.call('POST', '/v1/register', { capabilities: [...CAPABILITIES] });
    await assert.rejects(a.call('POST', '/v1/commands', { nodeId: 'node-b', text: 'open Arc' }), /themselves/);
    await assert.rejects(a.call('POST', '/v1/invite', {}), /unavailable/);
    const pending = f.controller.call('POST', '/v1/commands', { nodeId: 'node-b', text: 'open Arc' });
    const task = job(record(await b.call('GET', '/v1/poll')).job);
    await assert.rejects(a.call('POST', '/v1/result', { id: task.id, result: { ok: true, message: 'Done.' } }), /matching/);
    await b.call('POST', '/v1/result', { id: task.id, result: { ok: true, message: 'Done.' } });
    assert.equal(record(await pending).ok, true);
    await f.controller.call('POST', '/v1/revoke', { id: 'node-a' });
    await assert.rejects(a.call('GET', '/v1/nodes'), /Authentication/);
  } finally { await f.close(); }
});
test('timeouts do not replay commands, failed actions do not advance pronoun context', async () => {
  const f = await fixture(150);
  try {
    const node = await f.pair('node');
    await node.call('POST', '/v1/register', { capabilities: [...CAPABILITIES] });
    const pending = node.call('POST', '/v1/commands', { nodeId: 'node', text: 'open Arc' });
    const task = job(record(await node.call('GET', '/v1/poll')).job);
    assert.equal(record(await pending).ok, false);
    await assert.rejects(node.call('POST', '/v1/result', { id: task.id, result: { ok: true, message: 'Late.' } }), /matching/);
    assert.equal(record(await node.call('POST', '/v1/commands', { nodeId: 'node', text: 'put it in the top-left' })).ok, false);
    const failure = node.call('POST', '/v1/commands', { nodeId: 'node', text: 'open Arc' });
    const next = job(record(await node.call('GET', '/v1/poll')).job);
    assert.notEqual(next.id, task.id);
    await node.call('POST', '/v1/result', { id: next.id, result: { ok: false, message: 'App missing.' } });
    assert.equal(record(await failure).ok, false);
    assert.equal(record(await node.call('POST', '/v1/commands', { nodeId: 'node', text: 'put it in the top-left' })).ok, false);
  } finally { await f.close(); }
});
test('node applies its own permission policy even when the server grants a tool', async () => {
  const f = await fixture(); const abort = new AbortController(); let agent: Promise<void> | undefined;
  try {
    const node = await f.pair('restricted'); let ready!: () => void; const registered = new Promise<void>(resolve => { ready = resolve; });
    agent = runNode({ client: node, signal: abort.signal, preferences: { ...defaults, browser: 'com.apple.Safari', apps: {} },
      executor: { capabilities: async () => [...CAPABILITIES], execute: async () => { throw new Error('Should never execute'); } }, onStatus: () => ready() });
    await registered;
    const response = record(await node.call('POST', '/v1/commands', { nodeId: 'restricted', text: 'open Arc' }));
    assert.equal(response.ok, false); assert.match(String(response.message), /not allowed/);
  } finally { abort.abort(); await f.close(); await agent; }
});
