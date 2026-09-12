export interface Preferences {
  personality: string;
  browser: string;
  apps: Record<string, string>;
  sites: Record<string, string>;
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
