import { Hailbox } from "../src/store.js";

// A store on an in-memory database with a clock the test moves.
export function makeBox(opts = {}) {
  const clock = { t: Date.UTC(2026, 9, 9, 12, 0, 0) };
  const box = new Hailbox({ path: ":memory:", now: () => clock.t, ...opts });
  return { box, clock };
}

export const HOUR = 3600_000;
