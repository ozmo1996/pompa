import { test } from "node:test";
import assert from "node:assert/strict";
import { playbackPlan, appendChunk, removeRange } from "../beta/kamery/camera-logic.js";

test("Kamera: bufor bez skokow przy zwyklym opoznieniu, lagodne nadrabianie i histereza", () => {
  assert.deepEqual(playbackPlan(10, 1, 13), { rate: 1, seek: null });
  assert.deepEqual(playbackPlan(10, 1, 16), { rate: 1.04, seek: null });
  assert.deepEqual(playbackPlan(10, 1, 13, 1.04), { rate: 1.04, seek: null });
  assert.deepEqual(playbackPlan(10, 1, 12.5, 1.04), { rate: 1, seek: null });
  assert.deepEqual(playbackPlan(10, 1, 10.3), { rate: 0.98, seek: null });
  assert.deepEqual(playbackPlan(10, 1, 11, 0.98), { rate: 0.98, seek: null });
  assert.deepEqual(playbackPlan(10, 1, 12, 0.98), { rate: 1, seek: null });
  assert.deepEqual(playbackPlan(10, 1, 25), { rate: 1, seek: 22.5 });
  assert.deepEqual(playbackPlan(0, 10, 20), { rate: 1, seek: 17.5 });
  assert.deepEqual(playbackPlan(0, 0, NaN), { rate: 1, seek: null });
});

test("Kamera: dopisywanie i czyszczenie bufora sa przerywalne podczas Stop", async () => {
  class BufferMock extends globalThis.EventTarget {
    appendBuffer() {
      queueMicrotask(() => this.dispatchEvent(new globalThis.Event("updateend")));
    }
    remove() {
      queueMicrotask(() => this.dispatchEvent(new globalThis.Event("updateend")));
    }
  }
  const buffer = new BufferMock(),
    control = new globalThis.AbortController();
  await appendChunk(buffer, new Uint8Array([1, 2]), control.signal);
  await removeRange(buffer, 0, 10, control.signal);
  buffer.remove = () => {};
  const pending = removeRange(buffer, 0, 10, control.signal);
  control.abort();
  await assert.rejects(pending, /Przerwano/);
  await assert.rejects(appendChunk(buffer, new Uint8Array(), control.signal), /Przerwano/);
});
