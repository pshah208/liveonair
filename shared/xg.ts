export const HIGH_XG_SHOT_THRESHOLD = 0.30;

const PITCH_LENGTH_M = 105;
const PITCH_WIDTH_M = 68;
const GOAL_Y_M = PITCH_WIDTH_M / 2;
const GOAL_HALF_WIDTH_M = 7.32 / 2;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

/**
 * Illustrative synthetic xG from location only.
 *
 * Repo coordinates are a 0–100 attacking frame where x=100 is the goal being attacked and y=50 is centre.
 * We map that to a 105×68m pitch:
 *   xm = (x/100) * 105
 *   ym = (y/100) * 68
 */
export function illustrativeXg(x: number, y: number): number {
  const xM = clamp(x, 0, 100) / 100 * PITCH_LENGTH_M;
  const yM = clamp(y, 0, 100) / 100 * PITCH_WIDTH_M;
  const dx = Math.max(0.01, PITCH_LENGTH_M - xM);
  const dy = GOAL_Y_M - yM;
  const distanceM = Math.hypot(dx, dy);

  const postHigh = { x: PITCH_LENGTH_M, y: GOAL_Y_M - GOAL_HALF_WIDTH_M };
  const postLow = { x: PITCH_LENGTH_M, y: GOAL_Y_M + GOAL_HALF_WIDTH_M };
  const toHigh = { x: postHigh.x - xM, y: postHigh.y - yM };
  const toLow = { x: postLow.x - xM, y: postLow.y - yM };
  const dot = toHigh.x * toLow.x + toHigh.y * toLow.y;
  const cross = Math.abs(toHigh.x * toLow.y - toHigh.y * toLow.x);
  const theta = Math.atan2(cross, Math.max(1e-9, dot));

  const p = sigmoid(-1.15 - 0.08 * distanceM + 1.2 * theta);
  return clamp(p, 0.01, 0.60);
}
