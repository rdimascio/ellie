type IconName =
  | "dashboard"
  | "chat"
  | "today"
  | "world"
  | "space"
  | "finances"
  | "integrations"
  | "activity"
  | "settings"
  | "arrow"
  | "close"
  | "plus"
  | "tune";

const paths: Record<IconName, React.ReactNode> = {
  finances: (
    <>
      <path d="M20 8V6a2 2 0 0 0-2-2H6a3 3 0 0 0 0 6h14v10H6a3 3 0 0 1-3-3V7" />
      <path d="M20 13h-5v4h5" />
    </>
  ),
  integrations: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
      <path d="M14 6h2a2 2 0 0 1 2 2v2M10 18H8a2 2 0 0 1-2-2v-2" />
    </>
  ),
  dashboard: (
    <>
      <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z" />
    </>
  ),
  chat: (
    <>
      <path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z" />
    </>
  ),
  today: (
    <>
      <rect x="4" y="5" width="16" height="16" rx="4" />
      <path d="M8 3v4m8-4v4M4 11h16m-11 5h.01M13 16h2" />
    </>
  ),
  world: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M6.3 5.2a9 9 0 0 1 11.4 0M5.2 17.7a9 9 0 0 1 0-11.4m12.5 12.5a9 9 0 0 1-11.4 0m12.5-12.5a9 9 0 0 1 0 11.4" />
    </>
  ),
  space: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <path d="M17.5 14v7M14 17.5h7" />
    </>
  ),
  activity: (
    <>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </>
  ),
  settings: (
    <>
      <path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  arrow: (
    <>
      <path d="M5 12h14m-6-6 6 6-6 6" />
    </>
  ),
  close: (
    <>
      <path d="m6 6 12 12M6 18 18 6" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14M5 12h14" />
    </>
  ),
  tune: (
    <>
      <path d="M4 7h8m4 0h4M4 17h3m4 0h9" />
      <circle cx="14" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
};

export function InterfaceIcon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`interface-icon ${className}`}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function ElliePresence({ className = "" }: { className?: string }) {
  return (
    <span className={`ellie-presence ${className}`} aria-hidden="true">
      <span className="presence-halo" />
      <span className="presence-body" />
      <span className="presence-ring ring-one" />
      <span className="presence-ring ring-two" />
      <span className="presence-ring ring-three" />
      <span className="presence-light" />
    </span>
  );
}
