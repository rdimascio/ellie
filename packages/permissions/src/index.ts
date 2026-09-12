import { operationDefinition, record } from "@ellie/protocol";
import type { Action, Capability } from "@ellie/protocol";
import type { Preferences } from "@ellie/config/defaults";
export function authorize(
  actions: Action[],
  granted: readonly Capability[],
  prefs: Preferences,
): void {
  const apps = new Set([...Object.values(prefs.apps), prefs.browser]);
  const sites = new Set(Object.values(prefs.sites).map((url) => new URL(url).href));
  for (const action of actions) {
    const definition = operationDefinition(action.tool);
    const values = record(action);
    if (!granted.includes(definition.requiredCapability))
      throw new Error(`Node has not granted ${definition.requiredCapability}.`);
    if (definition.localPolicy.appFields.some((field) => !apps.has(String(values[field]))))
      throw new Error("App is not allowed on this node.");
    if (definition.localPolicy.urlFields.some((field) => !sites.has(String(values[field]))))
      throw new Error("Site is not allowed on this node.");
  }
}
