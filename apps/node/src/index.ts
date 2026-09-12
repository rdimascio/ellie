import { setTimeout as delay } from 'node:timers/promises';
import { job, record } from '@ellie/protocol';
import type { Result } from '@ellie/protocol';
import type { Preferences } from '@ellie/config';
import type { Executor } from '@ellie/macos';
import { authorize } from '@ellie/permissions';
import type { Client } from '@ellie/transport';

export async function runNode(options: { client: Client; executor: Executor; preferences: Preferences; signal: AbortSignal; onStatus?: (message: string) => void }): Promise<void> {
  const { client, executor, signal } = options;
  // Delivered jobs are never automatically repeated after a network error.
  const seen = new Set<string>();
  let backoff = 250;
  while (!signal.aborted) {
    try {
      const granted = await executor.capabilities();
      await client.call('POST', '/v1/register', { capabilities: granted });
      options.onStatus?.('Node connected. Ready for commands.');
      while (!signal.aborted) {
        const reply = record(await client.call('GET', '/v1/poll'));
        if (!reply.job) continue;
        const task = job(reply.job);
        let outcome: Result;
        try {
          if (task.expiresAt <= Date.now()) throw new Error('Command expired before execution.');
          if (seen.has(task.id)) throw new Error('Duplicate job blocked.');
          seen.add(task.id);
          if (seen.size > 1024) seen.delete(seen.values().next().value!);
          authorize(task.actions, granted, options.preferences);
          outcome = { ok: true, message: 'Done.' };
          for (const action of task.actions) {
            if (signal.aborted || Date.now() >= task.expiresAt) throw new Error('Command cancelled or expired.');
            outcome = await executor.execute(action);
            if (!outcome.ok) break;
          }
        } catch (error) { outcome = { ok: false, message: error instanceof Error ? error.message : 'Native action failed.' }; }
        await client.call('POST', '/v1/result', { id: task.id, result: outcome });
        backoff = 250;
      }
    } catch {
      if (signal.aborted) break;
      options.onStatus?.('Connection interrupted. Reconnecting; completed commands will not be replayed.');
      await delay(backoff, undefined, { signal }).catch(() => {});
      backoff = Math.min(backoff * 2, 5000);
    }
  }
}
