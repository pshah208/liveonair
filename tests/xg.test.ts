import assert from "node:assert/strict";
import test from "node:test";

import { illustrativeXg } from "../shared/xg.js";

test("illustrativeXg maps 0-100 attacking-frame coordinates to 105x68 checks", () => {
  assert.ok(Math.abs(illustrativeXg(84, 50) - 0.12) < 0.02);
  assert.ok(Math.abs(illustrativeXg(79, 50) - 0.07) < 0.02);
  assert.ok(Math.abs(illustrativeXg(95, 50) - 0.47) < 0.03);
});

test("illustrativeXg is bounded and location-only", () => {
  assert.ok(illustrativeXg(-20, 50) >= 0.01);
  assert.ok(illustrativeXg(200, 50) <= 0.60);
  assert.equal(illustrativeXg(85, 45), illustrativeXg(85, 45));
});
