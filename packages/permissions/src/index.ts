import type { Action, Capability } from '@ellie/protocol';
import type { Preferences } from '@ellie/config/defaults';
export function authorize(actions: Action[], granted: readonly Capability[], prefs: Preferences): void {
  const apps = new Set([...Object.values(prefs.apps), prefs.browser]);
  const sites = new Set(Object.values(prefs.sites).map(url => new URL(url).href));
  for (const action of actions) {
    if (!granted.includes(action.tool)) throw new Error(`Node has not granted ${action.tool}.`);
    if (!apps.has(action.app) || (action.tool === 'window.adjacent' && !apps.has(action.anchor))) throw new Error('App is not allowed on this node.');
    if (action.tool === 'url.open' && !sites.has(action.url)) throw new Error('Site is not allowed on this node.');
  }
}
