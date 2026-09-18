import { DESKTOP_CAPABILITIES } from "@ellie/protocol";
import type { Action, Capability, JobState } from "@ellie/protocol";

export const SCENARIOS = {
  ready: "Ready",
  loading: "Loading",
  offline: "Offline",
  empty: "No devices",
  running: "Command in progress",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Unknown outcome",
} as const;
export type Scenario = keyof typeof SCENARIOS;
export type View = "remote" | "tv";
export interface DemoDevice {
  id: string;
  name: string;
  room: string;
  available: boolean;
  capabilities: Capability[];
}
export interface DemoJob {
  id: number;
  title: string;
  target: string;
  state: JobState;
}
export interface DemoState {
  scenario: Scenario;
  devices: DemoDevice[];
  selected: string;
  jobs: DemoJob[];
  illustration: "welcome" | "app" | "site" | "left" | "adjacent";
  sequence: number;
}
export const STATUS_COPY: Record<JobState, { label: string; detail: string; tone: string }> = {
  queued: {
    label: "Waiting",
    detail: "Waiting for the selected Mac. You can cancel before it starts.",
    tone: "pending",
  },
  delivered: {
    label: "Sent",
    detail: "The Mac received the command. Completion is not yet confirmed.",
    tone: "pending",
  },
  running: {
    label: "In progress",
    detail: "The Mac is working. Cancellation may not undo an action already started.",
    tone: "pending",
  },
  cancellation_requested: {
    label: "Cancellation requested",
    detail: "Waiting for confirmation. An action already started may still finish.",
    tone: "pending",
  },
  completed: {
    label: "Completed",
    detail: "The Mac confirmed that the command completed.",
    tone: "success",
  },
  failed: {
    label: "Failed",
    detail:
      "The command did not complete. Check the selected Mac and its permissions before trying again.",
    tone: "attention",
  },
  cancelled: {
    label: "Cancelled",
    detail: "The request is cancelled. Cancellation does not undo an action already started.",
    tone: "neutral",
  },
  expired: {
    label: "Expired",
    detail: "The deadline passed. Ellie will not automatically repeat the command.",
    tone: "attention",
  },
  unknown: {
    label: "Outcome unknown",
    detail:
      "Check this Mac before trying again. The action may have happened; Ellie will not repeat it automatically.",
    tone: "attention",
  },
};
export const DEMO_ACTIONS = [
  {
    title: "Open Arc",
    description: "Your browser, ready to go",
    symbol: "A",
    kind: "app",
    action: { tool: "app.open", app: "company.thebrowser.Browser" },
  },
  {
    title: "Open Netflix",
    description: "Settle in for something good",
    symbol: "N",
    kind: "site",
    action: {
      tool: "url.open",
      app: "company.thebrowser.Browser",
      url: "https://example.com/watch",
    },
  },
  {
    title: "Tile Arc left",
    description: "Make a little room",
    symbol: "left",
    kind: "left",
    action: {
      tool: "window.place",
      app: "company.thebrowser.Browser",
      layout: "left",
      monitor: "current",
    },
  },
  {
    title: "Safari beside Arc",
    description: "Two windows, side by side",
    symbol: "adjacent",
    kind: "adjacent",
    action: {
      tool: "window.adjacent",
      app: "com.apple.Safari",
      anchor: "company.thebrowser.Browser",
    },
  },
] as const satisfies ReadonlyArray<{
  title: string;
  description: string;
  symbol: string;
  kind: DemoState["illustration"];
  action: Action;
}>;

export const AGENDA = [
  {
    time: "4:30",
    period: "pm",
    title: "A little fresh air",
    detail: "Walk around the neighborhood",
    kind: "Walk",
  },
  {
    time: "6:00",
    period: "pm",
    title: "Dinner together",
    detail: "Pasta night at home",
    kind: "Dinner",
  },
  {
    time: "8:00",
    period: "pm",
    title: "The good kind of evening",
    detail: "Pick a movie. Find a blanket.",
    kind: "Movie",
  },
] as const;

export function scenarioState(scenario: Scenario, sequence = 0): DemoState {
  const devices =
    scenario === "empty"
      ? []
      : [
          {
            id: "demo-living-room",
            name: "Living room Mac",
            room: "Living room",
            available: scenario !== "offline" && scenario !== "loading",
            capabilities: [...DESKTOP_CAPABILITIES],
          },
          {
            id: "demo-study",
            name: "Study Mac",
            room: "Study",
            available: scenario !== "offline" && scenario !== "loading",
            capabilities: ["app.open", "url.open"] as Capability[],
          },
          {
            id: "demo-laptop",
            name: "Laptop",
            room: "Around the house",
            available: false,
            capabilities: [...DESKTOP_CAPABILITIES],
          },
        ];
  const state: JobState = ["running", "completed", "failed", "cancelled", "unknown"].includes(
    scenario,
  )
    ? (scenario as JobState)
    : "completed";
  return {
    scenario,
    devices,
    selected: devices[0]?.id ?? "",
    sequence,
    jobs:
      scenario === "empty" || scenario === "loading"
        ? []
        : [{ id: sequence, title: "Open Arc", target: "Living room Mac", state }],
    illustration: "welcome",
  };
}

export function canSubmit(state: DemoState, capability: Capability): boolean {
  const device = state.devices.find((item) => item.id === state.selected);
  return (
    !!device?.available &&
    device.capabilities.includes(capability) &&
    !state.jobs.some((job) =>
      ["queued", "delivered", "running", "cancellation_requested"].includes(job.state),
    )
  );
}
export type DemoEvent =
  | { type: "scenario"; scenario: Scenario }
  | { type: "select"; id: string }
  | { type: "submit"; index: number }
  | { type: "complete"; id: number; illustration: DemoState["illustration"] }
  | { type: "cancel"; id: number };

export function reduceDemo(state: DemoState, event: DemoEvent): DemoState {
  if (event.type === "scenario") return scenarioState(event.scenario, state.sequence + 1);
  if (event.type === "select")
    return state.devices.some((device) => device.id === event.id)
      ? { ...state, selected: event.id, illustration: "welcome" }
      : state;
  if (event.type === "submit") {
    const command = DEMO_ACTIONS[event.index];
    if (!command || !canSubmit(state, command.action.tool)) return state;
    const target = state.devices.find((device) => device.id === state.selected)!;
    return {
      ...state,
      sequence: state.sequence + 1,
      jobs: [
        {
          id: state.sequence + 1,
          title: command.title,
          target: target.name,
          state: "queued" as const,
        },
        ...state.jobs,
      ].slice(0, 5),
    };
  }
  const active = state.jobs.find((job) => job.id === event.id);
  if (!active || !["queued", "running", "delivered"].includes(active.state)) return state;
  if (event.type === "complete" && active.state !== "queued") return state;
  return {
    ...state,
    illustration:
      event.type === "complete" &&
      state.devices.find((device) => device.id === state.selected)?.name === active.target
        ? event.illustration
        : state.illustration,
    jobs: state.jobs.map((job) =>
      job.id === event.id
        ? {
            ...job,
            state:
              event.type === "cancel"
                ? job.state === "queued"
                  ? "cancelled"
                  : "cancellation_requested"
                : "completed",
          }
        : job,
    ),
  };
}
