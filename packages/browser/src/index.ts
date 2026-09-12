export interface BrowserSkill {
  id: string;
  browser: string;
  capabilities: readonly string[];
}
// Browser automation is deferred. V1 only opens explicitly allowed HTTPS sites via macOS.
// Browser profiles, sessions, and cookies stay owned by the browser.
