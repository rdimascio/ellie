const maximumCount = 99;

function bounded(value) {
  return Math.min(Math.max(value, 0), maximumCount);
}

export class SpeechStartDiagnostics {
  #uploads = 0;
  #uploadsByOwner = new Map();
  #turnOwners = new Map();
  #settled = new Set();
  #observations = new WeakSet();
  #lastStarts;
  #lastExits;
  #controlReason = "none";
  #controlState = "none";

  noteUpload(owner) {
    this.#uploads += 1;
    this.#uploadsByOwner.set(owner, (this.#uploadsByOwner.get(owner) ?? 0) + 1);
  }

  delivered(turn, owner) {
    this.#turnOwners.set(turn, owner);
  }

  settled(turn) {
    if (this.#turnOwners.has(turn)) this.#settled.add(turn);
  }

  observe(owner, phase, marker, starts, exits) {
    this.#lastStarts = starts.length;
    this.#lastExits = exits.length;
    const turns = [...this.#turnOwners]
      .filter(([, value]) => value === owner)
      .map(([turn]) => turn);
    const active = turns.filter((turn) => !this.#settled.has(turn));
    const state = turns.length === 0 ? "none" : active.length > 0 ? "pending" : "terminal";
    const ready =
      phase === "started"
        ? active.length > 0 && starts.includes(marker)
        : turns.length === 1 && active.length === 0 && exits.includes(marker);
    if (ready) {
      const result = Object.freeze({ ready: true, reason: "none", state });
      this.#observations.add(result);
      return result;
    }
    const reason =
      turns.length === 0
        ? (this.#uploadsByOwner.get(owner) ?? 0) > 0
          ? "no-delivered-turn"
          : "no-upload"
        : turns.length !== 1
          ? "unexpected-turn-count"
          : phase === "started" && active.length === 0
            ? "no-active-turn"
            : phase === "settled" && active.length > 0
              ? "turn-not-settled"
              : !(phase === "started" ? starts : exits).includes(marker)
                ? "no-worker-marker"
                : "no-active-turn";
    const result = Object.freeze({ ready: false, reason, state });
    this.#observations.add(result);
    return result;
  }

  timeout(observation) {
    if (!observation || typeof observation !== "object" || !this.#observations.has(observation))
      return;
    this.#controlReason = observation.ready ? "ready-after-deadline" : observation.reason;
    this.#controlState = observation.state;
  }

  summary(starts, exits) {
    if (Array.isArray(starts)) this.#lastStarts = starts.length;
    if (Array.isArray(exits)) this.#lastExits = exits.length;
    const active = [...this.#turnOwners].filter(([turn]) => !this.#settled.has(turn)).length;
    return [
      `uploads:${bounded(this.#uploads)}`,
      `starts:${this.#lastStarts === undefined ? "unavailable" : bounded(this.#lastStarts)}`,
      `exits:${this.#lastExits === undefined ? "unavailable" : bounded(this.#lastExits)}`,
      `active:${bounded(active)}`,
      `settled:${bounded(this.#settled.size)}`,
      `control:${this.#controlReason}`,
      `controlState:${this.#controlState}`,
    ].join(",");
  }
}
