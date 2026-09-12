import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { load, save } from '@ellie/config';
export const newToken = (): string => randomBytes(32).toString('hex');
const hash = (token: string): string => createHash('sha256').update(token).digest('hex');
const equal = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
interface Identity { id: string; role: 'controller' | 'node'; tokenHash: string }
interface State { identities: Identity[]; invitation?: { hash: string; expiresAt: number } }
export class Auth {
  private state: State;
  private persist: (state: State) => Promise<void>;
  private lock: Promise<void> = Promise.resolve();
  constructor(state: State, persist: (state: State) => Promise<void>) { this.state = state; this.persist = persist; }
  static async open(dir?: string): Promise<Auth> { return new Auth(await load<State>('auth.json', dir), state => save('auth.json', state, dir)); }
  static async initialize(controller: string, dir?: string): Promise<void> { await save('auth.json', { identities: [{ id: 'controller', role: 'controller', tokenHash: hash(controller) }] }, dir); }
  authenticate(header?: string): Identity | undefined {
    if (!header || !/^Bearer [a-f0-9]{64}$/.test(header)) return undefined;
    const digest = hash(header.slice(7));
    return this.state.identities.find(identity => equal(identity.tokenHash, digest));
  }
  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock; let release!: () => void;
    this.lock = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
  async invite(): Promise<{ code: string; expiresAt: number }> {
    return this.mutate(async () => {
      const code = newToken(); const expiresAt = Date.now() + 10 * 60_000;
      const next = { ...this.state, invitation: { hash: hash(code), expiresAt } };
      await this.persist(next); this.state = next;
      return { code, expiresAt };
    });
  }
  async pair(code: string, id: string): Promise<string> {
    return this.mutate(async () => {
      const invitation = this.state.invitation;
      if (!invitation || invitation.expiresAt < Date.now() || !equal(invitation.hash, hash(code))) throw new Error('Pairing code is invalid or expired.');
      if (this.state.identities.some(identity => identity.id === id)) throw new Error('Node ID already exists.');
      const token = newToken();
      const next: State = { identities: [...this.state.identities, { id, role: 'node', tokenHash: hash(token) }] };
      await this.persist(next); this.state = next;
      return token;
    });
  }
  async revoke(id: string): Promise<void> {
    return this.mutate(async () => {
      const next = { ...this.state, identities: this.state.identities.filter(identity => identity.role !== 'node' || identity.id !== id) };
      await this.persist(next); this.state = next;
    });
  }
}
