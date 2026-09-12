import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stateDir, ensureState, save, load, defaults, serverConfig, nodeConfig, serverUrl, Keychain } from '@ellie/config';
import { identifier, record, string, result } from '@ellie/protocol';
import { Client, discoverCertificate, fingerprint } from '@ellie/transport';
import { MacOSExecutor } from '@ellie/macos';
import { Auth, newToken } from '../../server/src/auth.ts';
import { createEllieServer } from '../../server/src/index.ts';
import { runNode } from '../../node/src/index.ts';

const args = process.argv.slice(2);
const secrets = new Keychain();
async function exists(name: string): Promise<boolean> { try { await access(join(stateDir, name)); return true; } catch { return false; } }
async function ask(prompt: string, secret = false): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Onboarding requires an interactive terminal.');
  const output = secret ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : process.stdout;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    if (secret) process.stdout.write(prompt);
    const value = (await rl.question(secret ? '' : prompt)).trim();
    if (secret) process.stdout.write('\n');
    return value;
  } finally { rl.close(); }
}
async function controller(): Promise<Client> {
  const config = serverConfig(await load('server.json'));
  return new Client(`https://127.0.0.1:${config.port}`, await readFile(join(stateDir, 'server-cert.pem'), 'utf8'), await secrets.get('server.controller'));
}
async function withController(fn: (client: Client) => Promise<void>): Promise<void> {
  const client = await controller();
  try { await fn(client); } finally { client.close(); }
}
async function main(): Promise<void> {
  if (args[0] === 'server' && args[1] === 'init') {
    if (await exists('server.json')) throw new Error('Server is already initialized. Existing identity was preserved.');
    await ensureState();
    const certPath = join(stateDir, 'server-cert.pem');
    let key: string;
    try {
      const generated = await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '-', '-out', certPath, '-days', '365', '-subj', '/CN=ellie.local']);
      key = generated.stdout;
      if (!key.includes('PRIVATE KEY')) throw new Error('No key generated.');
    } catch { throw new Error('Certificate creation failed. Ensure openssl is available.'); }
    const token = newToken();
    await secrets.set('server.key', key);
    await secrets.set('server.controller', token);
    await Auth.initialize(token);
    await save('server.json', { version: 1, host: args.includes('--lan') ? '0.0.0.0' : '127.0.0.1', port: 7437, preferences: defaults });
    console.log('Server initialized. Start it with: npm run ellie -- server start');
    return;
  }
  if (args[0] === 'server' && args[1] === 'start') {
    const config = serverConfig(await load('server.json'));
    const cert = await readFile(join(stateDir, 'server-cert.pem'), 'utf8');
    const app = createEllieServer({ key: await secrets.get('server.key'), cert, auth: await Auth.open(), preferences: config.preferences });
    await new Promise<void>((resolve, reject) => { app.server.once('error', reject); app.server.listen(config.port, config.host, () => resolve()); });
    console.log(`Ellie server ready on port ${config.port}. No model or cloud API is required.`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => app.shutdown());
    return;
  }
  if (args[0] === 'server' && args[1] === 'pair') {
    await withController(async client => {
      const invite = record(await client.call('POST', '/v1/invite', {}));
      console.log('Server SHA-256 fingerprint (verify on the node):');
      console.log(fingerprint(await readFile(join(stateDir, 'server-cert.pem'), 'utf8')));
      console.log('One-time pairing code, valid for 10 minutes. Enter only into your node pairing prompt:');
      console.log(string(invite.code, 64));
    });
    return;
  }
  if (args[0] === 'server' && args[1] === 'revoke') {
    const id = identifier(args[2]);
    await withController(async client => { await client.call('POST', '/v1/revoke', { id }); console.log('Node revoked.'); });
    return;
  }
  if (args[0] === 'node' && args[1] === 'pair') {
    if (await exists('node.json')) throw new Error('This node is already paired. See docs/security.md for re-pairing.');
    await ensureState();
    // Check Keychain/helper availability before consuming an invitation.
    const id = randomUUID();
    await secrets.set(`node.${id}`, 'pending-pairing');
    const origin = serverUrl(await ask('Server URL (https:// plus its LAN address and :7437): '));
    const pin = await ask('Server SHA-256 fingerprint: ');
    const cert = await discoverCertificate(origin, pin);
    const code = await ask('One-time pairing code (hidden): ', true);
    const client = new Client(origin, cert);
    try {
      const response = record(await client.call('POST', '/v1/pair', { id, code }));
      await secrets.set(`node.${id}`, string(response.token, 64));
      await writeFile(join(stateDir, 'node-server-cert.pem'), cert, { mode: 0o600 });
      await save('node.json', { version: 1, id, serverUrl: origin, preferences: defaults });
      console.log('Paired. Run npm run ellie -- doctor, then npm run ellie -- node start');
    } finally { client.close(); }
    return;
  }
  if (args[0] === 'node' && args[1] === 'start') {
    const config = nodeConfig(await load('node.json'));
    const client = new Client(config.serverUrl, await readFile(join(stateDir, 'node-server-cert.pem'), 'utf8'), await secrets.get(`node.${config.id}`));
    const abort = new AbortController();
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { abort.abort(); client.close(); });
    try { await runNode({ client, executor: new MacOSExecutor(), preferences: config.preferences, signal: abort.signal, onStatus: console.log }); }
    finally { client.close(); }
    return;
  }
  if (args[0] === 'doctor') {
    const capabilities = await new MacOSExecutor().capabilities();
    console.log(`Available tools: ${capabilities.join(', ')}`);
    if (!capabilities.includes('window.place')) {
      console.log('Enable your terminal and ~/.ellie/bin/ellie-macos in System Settings > Privacy & Security > Accessibility. Restart the node afterward.');
      process.exitCode = 1;
    }
    return;
  }
  if (args[0] === 'nodes') {
    await withController(async client => { console.log(JSON.stringify(await client.call('GET', '/v1/nodes'), null, 2)); });
    return;
  }
  if (args[0] === 'say') {
    let client: Client; let nodeId: string; let words: string[];
    if (args[1] === '--node') {
      nodeId = identifier(args[2]); words = args.slice(3); client = await controller();
    } else {
      const config = nodeConfig(await load('node.json'));
      nodeId = config.id; words = args.slice(1);
      client = new Client(config.serverUrl, await readFile(join(stateDir, 'node-server-cert.pem'), 'utf8'), await secrets.get(`node.${config.id}`));
    }
    try {
      const response = result(await client.call('POST', '/v1/commands', { nodeId, text: string(words.join(' '), 500) }));
      console.log(response.message);
      if (!response.ok) process.exitCode = 1;
    } finally { client.close(); }
    return;
  }
  console.log(`Ellie — local-first personal assistant\n\n  server init [--lan]   Generate private config and Keychain identity\n  server start          Start the HTTPS coordinator\n  server pair           Issue a single-use pairing invitation\n  server revoke ID      Revoke a paired node\n  node pair             Pair this Mac interactively\n  node start            Run this Mac's execution agent\n  doctor                Check native helper and Accessibility\n  nodes                 List connected nodes (server Mac)\n  say "open Arc"        Send a command to this paired Mac\n  say --node ID "..."   Target a paired Mac from the server`);
}
main().catch(error => {
  const code = (error as NodeJS.ErrnoException).code;
  console.error(code === 'ENOENT' ? 'Private configuration is missing. Run server init or node pair first.' : error instanceof Error ? error.message : 'Ellie could not complete the request.');
  process.exitCode = 1;
});
