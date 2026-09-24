import { randomUUID } from "node:crypto";

export interface AxFixtureNode {
  kind: "webArea" | "address" | "search" | "link" | "button" | "text" | "scrollArea";
  label?: string;
  value?: string;
  enabled: boolean;
  actions: string[];
}
export interface AxFixturePage {
  url: string;
  title: string;
  nodes: AxFixtureNode[];
  scrollDirections: ("up" | "down")[];
}

const WATCH_VALUE = /^https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/;

/**
 * Mirrors BrowserAccessibility.swift's selectableVideoLinks + read: an enabled link with a
 * "press" action, a valid label, and a bare https://www.youtube.com/watch?v=<11 chars> value,
 * keeping only entries whose video id is unique on the page. Mints a fresh id per call, exactly
 * as the Swift accessibility read mints a fresh UUID per item per read.
 */
export function axSelectableItems(page: AxFixturePage): { id: string; label: string }[] {
  const candidates: { label: string; videoId: string }[] = [];
  const counts = new Map<string, number>();
  for (const node of page.nodes) {
    if (node.kind !== "link" || !node.enabled || !node.actions.includes("press")) continue;
    if (!node.label || !node.value) continue;
    const match = WATCH_VALUE.exec(node.value);
    if (!match) continue;
    const videoId = match[1]!;
    candidates.push({ label: node.label, videoId });
    counts.set(videoId, (counts.get(videoId) ?? 0) + 1);
  }
  return candidates
    .filter((candidate) => counts.get(candidate.videoId) === 1)
    .map((candidate) => ({ id: randomUUID(), label: candidate.label }));
}

function video(label: string, videoId: string): AxFixtureNode {
  return {
    kind: "link",
    label,
    value: `https://www.youtube.com/watch?v=${videoId}`,
    enabled: true,
    actions: ["press"],
  };
}

export const YOUTUBE_PURSUIT_PAGES: Record<
  "home" | "results" | "watch" | "unrelated",
  AxFixturePage
> = {
  home: {
    url: "https://www.youtube.com/",
    title: "YouTube",
    scrollDirections: ["down"],
    nodes: [
      { kind: "webArea", label: "YouTube", enabled: true, actions: ["scroll-down"] },
      { kind: "address", value: "https://www.youtube.com/", enabled: true, actions: [] },
      { kind: "search", label: "Search", enabled: true, actions: ["press"] },
      video("Lo-fi beats to code to - 24/7 live radio", "jfKfPfyJRdk"),
      video("Deep focus mix - 2 hour study session", "5qap5aO4i9A"),
      video("Synthwave radio - beats to relax/game to", "4xDzrJKXOOY"),
      video("Ambient study music for concentration", "DWcJFNfaw9c"),
      video("Coding playlist - lofi hip hop radio", "rUxyKA_-grg"),
    ],
  },
  results: {
    url: "https://www.youtube.com/results?search_query=lofi",
    title: "lofi - YouTube",
    scrollDirections: ["down", "up"],
    nodes: [
      {
        kind: "webArea",
        label: "lofi - YouTube",
        enabled: true,
        actions: ["scroll-up", "scroll-down"],
      },
      {
        kind: "address",
        value: "https://www.youtube.com/results?search_query=lofi",
        enabled: true,
        actions: [],
      },
      { kind: "search", label: "Search", value: "lofi", enabled: true, actions: ["press"] },
      video("Lo-fi beats to code to - 24/7 live radio", "jfKfPfyJRdk"),
      video("Chillhop essentials - lofi hip hop mix", "7NOSDKb0HlU"),
      video("Rainy day lofi playlist", "kgx4WGK0oNU"),
      video("Late night lofi radio - beats to sleep to", "S_MOd40zlYU"),
    ],
  },
  watch: {
    url: "https://www.youtube.com/watch?v=jfKfPfyJRdk",
    title: "Lo-fi beats to code to - 24/7 live radio - YouTube",
    scrollDirections: ["down"],
    nodes: [
      {
        kind: "webArea",
        label: "Lo-fi beats to code to - 24/7 live radio - YouTube",
        enabled: true,
        actions: ["scroll-down"],
      },
      {
        kind: "address",
        value: "https://www.youtube.com/watch?v=jfKfPfyJRdk",
        enabled: true,
        actions: [],
      },
      { kind: "button", label: "Pause", enabled: true, actions: ["press"] },
      video("Deep focus mix - 2 hour study session", "5qap5aO4i9A"),
      video("Synthwave radio - beats to relax/game to", "4xDzrJKXOOY"),
      video("Ambient study music for concentration", "DWcJFNfaw9c"),
    ],
  },
  unrelated: {
    url: "https://example.com/",
    title: "Example Domain",
    scrollDirections: ["down"],
    nodes: [
      { kind: "webArea", label: "Example Domain", enabled: true, actions: ["scroll-down"] },
      { kind: "address", value: "https://example.com/", enabled: true, actions: [] },
      {
        kind: "text",
        label: "This domain is for use in illustrative examples in documents.",
        enabled: true,
        actions: [],
      },
    ],
  },
};
