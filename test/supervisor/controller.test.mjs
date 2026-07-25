import test from "node:test";
import assert from "node:assert/strict";
import { decideTransition } from "../../src/supervisor/controller.mjs";

test("90 percent requests checkpoint", () => {
  assert.deepEqual(
    decideTransition({
      state: "running",
      used: 0.90,
      prepareAt: 0.90,
      forceAt: 0.95,
      heartbeatFresh: true,
      processAlive: true,
      checkpoint: null,
    }).action,
    "request_handoff"
  );
});

test("fresh checkpointing worker is observed below force threshold", () => {
  assert.equal(
    decideTransition({
      state: "handoff_preparing",
      used: 0.93,
      prepareAt: 0.90,
      forceAt: 0.95,
      heartbeatFresh: true,
      processAlive: true,
      checkpoint: null,
    }).action,
    "observe"
  );
});

test("force threshold progresses with partial durable state", () => {
  assert.equal(
    decideTransition({
      state: "handoff_preparing",
      used: 0.95,
      prepareAt: 0.90,
      forceAt: 0.95,
      heartbeatFresh: true,
      processAlive: true,
      checkpoint: null,
    }).action,
    "force_handoff"
  );
});
