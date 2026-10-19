import { MAINTENANCE_DURATION_MIN } from "./simulator.js";

/** Mean time to repair after an unplanned bearing failure on a CNC cell (fixture value). */
export const UNPLANNED_MTTR_MIN = 240;

/**
 * Downtime avoided = expected unplanned downtime − planned downtime we chose instead.
 * expected = MTTR × P(failure before the planned window). Shown in the UI with its inputs.
 */
export function downtimeAvoided(input: { pFailure: number; workOrderOpened: boolean }): {
  minutes: number;
  expectedUnplanned: number;
  planned: number;
} {
  const expectedUnplanned = Math.round(UNPLANNED_MTTR_MIN * input.pFailure);
  const planned = input.workOrderOpened ? MAINTENANCE_DURATION_MIN : 0;
  return { minutes: Math.max(0, expectedUnplanned - planned), expectedUnplanned, planned };
}
