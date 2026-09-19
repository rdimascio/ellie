export interface Preferences {
  personality: string;
  browser: string;
  apps: Record<string, string>;
  sites: Record<string, string>;
  /** Optional per-site browser overrides keyed by site alias; falls back to `browser`. */
  siteBrowsers?: Record<string, string>;
}

/** The browser configured for one site alias, falling back to the default browser. */
export function browserForSite(alias: string | undefined, prefs: Preferences): string {
  const overrides = prefs.siteBrowsers;
  if (alias && overrides && Object.hasOwn(overrides, alias)) return overrides[alias]!;
  return prefs.browser;
}
export const defaults: Preferences = {
  personality: "ellie",
  browser: "company.thebrowser.Browser",
  apps: {
    arc: "company.thebrowser.Browser",
    messages: "com.apple.MobileSMS",
    safari: "com.apple.Safari",
    notes: "com.apple.Notes",
    calendar: "com.apple.iCal",
  },
  sites: { netflix: "https://www.netflix.com/", youtube: "https://www.youtube.com/" },
};
