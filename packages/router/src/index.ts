import { action } from "@ellie/protocol";
import type { Context, Plan, Layout, Monitor } from "@ellie/protocol";
import { browserForUrl, defaults } from "@ellie/config/defaults";
import type { Preferences } from "@ellie/config/defaults";

/** Pure, anchored grammar. Unknown text never becomes executable code or shell input. */
export function route(
  input: string,
  context: Context = {},
  prefs: Preferences = defaults,
): Plan | undefined {
  const text = input
    .toLowerCase()
    .trim()
    .replace(/^ellie[,!]?\s+/, "")
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ");
  const appAlias = (name: string): string | undefined =>
    Object.hasOwn(prefs.apps, name) ? prefs.apps[name] : undefined;
  const resolve = (name: string): string | undefined =>
    ["it", "that", "the window"].includes(name) ? context.lastApp : appAlias(name);
  let m: RegExpMatchArray | null;
  if ((m = text.match(/^open app ([a-z0-9 -]+)$/))) {
    const app = appAlias(m[1]!);
    if (!app) return undefined;
    return { actions: [action({ tool: "app.open", app })], nextContext: { lastApp: app } };
  }
  if ((m = text.match(/^(?:open|launch|start) ([a-z0-9 -]+)$/))) {
    const name = m[1]!;
    const app = appAlias(name);
    if (app) return { actions: [action({ tool: "app.open", app })], nextContext: { lastApp: app } };
    const url = Object.hasOwn(prefs.sites, name) ? prefs.sites[name] : undefined;
    if (url) {
      const browser = browserForUrl(url, prefs);
      return {
        actions: [action({ tool: "url.open", app: browser, url })],
        nextContext: { lastApp: browser },
      };
    }
  }
  if ((m = text.match(/^put ([a-z0-9 -]+) next to (it|that|[a-z0-9 -]+)$/))) {
    const app = resolve(m[1]!);
    const anchor = resolve(m[2]!);
    if (app && anchor && app !== anchor)
      return {
        actions: [action({ tool: "window.adjacent", app, anchor })],
        nextContext: { lastApp: app },
      };
  }
  if (
    (m = text.match(
      /^(?:put|move) ([a-z0-9 -]+?) (?:in|to|on) (?:the )?(top[- ]left|top[- ]right|bottom[- ]left|bottom[- ]right|left|right)$/,
    ))
  ) {
    const app = resolve(m[1]!);
    const layout = m[2]!.replace(" ", "-") as Layout;
    if (app)
      return {
        actions: [action({ tool: "window.place", app, layout, monitor: "current" })],
        nextContext: { lastApp: app },
      };
  }
  if (
    (m = text.match(
      /^move ([a-z0-9 -]+?) to (?:the )?(big|largest|main|primary) (?:monitor|screen)(?: and (?:make it |put it in )?(fullscreen|full screen|maximized))?$/,
    ))
  ) {
    const app = resolve(m[1]!);
    const monitor: Monitor = ["big", "largest"].includes(m[2]!) ? "largest" : "primary";
    if (app)
      return {
        actions: [
          action({
            tool: "window.place",
            app,
            layout: m[3] && m[3] !== "maximized" ? "fullscreen" : "maximize",
            monitor,
          }),
        ],
        nextContext: { lastApp: app },
      };
  }
  if (
    (m = text.match(/^(?:make|put) ([a-z0-9 -]+?) (?:in )?(fullscreen|full screen|maximized)$/))
  ) {
    const app = resolve(m[1]!);
    if (app)
      return {
        actions: [
          action({
            tool: "window.place",
            app,
            layout: m[2] === "maximized" ? "maximize" : "fullscreen",
            monitor: "current",
          }),
        ],
        nextContext: { lastApp: app },
      };
  }
  return undefined;
}
