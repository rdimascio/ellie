export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Display {
  id: string;
  frame: Rect;
  workArea: Rect;
  primary: boolean;
}
/** Shared contract; native adapters own coordinate conversion and OS constraints. */
export interface WindowSnapshot {
  app: string;
  displayId: string;
  frame: Rect;
  fullscreen: boolean;
}
