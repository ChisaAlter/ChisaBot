import { describe, expect, test } from "bun:test";
import {
  CAPTURE_BUSY_IN_FLIGHT,
  CAPTURE_BUSY_LIVE_CAST,
  CaptureBusyError,
  createCaptureGate,
} from "../src/capture-gate";

describe("capture gate (screenshot ↔ LiveScreen)", () => {
  test("refuses while live cast is up without taking the slot", () => {
    const gate = createCaptureGate();
    expect(() => gate.enter(true)).toThrow(CaptureBusyError);
    try {
      gate.enter(true);
    } catch (error) {
      expect(error).toBeInstanceOf(CaptureBusyError);
      const busy = error as CaptureBusyError;
      expect(busy.liveCast).toBe(true);
      expect(busy.captureBusy).toBe(true);
      expect(busy.message).toBe(CAPTURE_BUSY_LIVE_CAST);
    }
    expect(gate.pending()).toBe(0);
  });

  test("admits one capture and refuses a concurrent second", () => {
    const gate = createCaptureGate();
    const release = gate.enter(false);
    expect(gate.pending()).toBe(1);
    expect(() => gate.enter(false)).toThrow(CaptureBusyError);
    try {
      gate.enter(false);
    } catch (error) {
      const busy = error as CaptureBusyError;
      expect(busy.liveCast).toBe(false);
      expect(busy.message).toBe(CAPTURE_BUSY_IN_FLIGHT);
    }
    release();
    expect(gate.pending()).toBe(0);
    const again = gate.enter(false);
    expect(gate.pending()).toBe(1);
    again();
    expect(gate.pending()).toBe(0);
  });

  test("stale second release does not clear a later admit", () => {
    const gate = createCaptureGate();
    const first = gate.enter(false);
    first();
    first(); // stale
    const second = gate.enter(false);
    expect(gate.pending()).toBe(1);
    first(); // must not clear second
    expect(gate.pending()).toBe(1);
    second();
    expect(gate.pending()).toBe(0);
  });
});
