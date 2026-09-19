export interface Preferences {
  personality: string;
  browser: string;
  apps: Record<string, string>;
  sites: Record<string, string>;
  /** Optional browser per configured site URL; falls back to `browser`. */
  siteBrowsers?: Record<string, string>;
}

/** The browser configured for one site URL, falling back to the default browser. */
export function browserForUrl(url: string, prefs: Preferences): string {
  const overrides = prefs.siteBrowsers;
  return overrides && Object.hasOwn(overrides, url) ? overrides[url]! : prefs.browser;
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
