export type SpeechControlObservation = {
  readonly ready: boolean;
  readonly reason:
    | "none"
    | "no-upload"
    | "no-delivered-turn"
    | "no-active-turn"
    | "no-worker-marker"
    | "turn-not-settled"
    | "unexpected-turn-count";
  readonly state: "none" | "pending" | "terminal";
};

export class SpeechStartDiagnostics {
  noteUpload(owner: string): void;
  /** Records entry into the transcribe wrapper; it does not imply completed authorization. */
  delivered(turn: string, owner: string): void;
  settled(turn: string): void;
  observe(
    owner: string,
    phase: "started" | "settled",
    marker: string,
    starts: string[],
    exits: string[],
  ): SpeechControlObservation;
  timeout(observation: SpeechControlObservation): void;
  summary(starts?: string[], exits?: string[]): string;
}
