import { test } from "node:test";
import assert from "node:assert/strict";
import { VALVES, PRESSURES, valveRecommendation } from "../js/valveTable.js";
import { wetBulb, stationPressure } from "../js/logic.js";
test("600 ECO: tabela ma 272 poprawne komórki i wskazówki w punktach tabeli", () => {
  assert.equal(VALVES.length, 17);
  for (let row = 0; row < 17; row++) {
    assert.equal(VALVES[row].length, 16);
    for (let col = 0; col < 16; col++) {
      assert.match(VALVES[row][col], /^[1-4](\+[1-4])*$/);
      assert.equal(valveRecommendation(-row - 1, PRESSURES[col]).valves.join("+"), VALVES[row][col]);
    }
  }
  for (const [t, p, v] of [
    [-1, 10, "2"],
    [-3, 22, "1+2"],
    [-4, 24, "3"],
    [-6, 20, "1+2+3"],
    [-9, 10, "1+2+3+4"],
    [-11, 40, "1+4"],
    [-14, 30, "2+3+4"],
    [-17, 40, "1+2+3+4"],
  ])
    assert.equal(valveRecommendation(t, p).valves.join("+"), v);
});
test("600 ECO: granice, brak danych i jawne zaokrąglenie między punktami", () => {
  assert.deepEqual(valveRecommendation(-5.6, 31), { temperature: -5, pressure: 32, valves: [1, 3], coldEnd: false });
  assert.equal(valveRecommendation(-20, 32).temperature, -17);
  for (const [t, p] of [
    [-0.9, 32],
    [-5, 9.9],
    [-5, 40.1],
    [null, 32],
    [-5, null],
    [NaN, 32],
  ])
    assert.equal(valveRecommendation(t, p), null);
});
test("Mokry termometr: punkty referencyjne, nasycenie, monotoniczność i ciśnienie", () => {
  // Niezależny punkt: 20°C / 50% przy 1013,25 hPa ≈13,8°C (psychrometr nad wodą).
  assert.ok(Math.abs(wetBulb(20, 50, 1013.25) - 13.8) < 0.15);
  for (const t of [-30, -17, -5, 0, 20, 50]) {
    assert.ok(Math.abs(wetBulb(t, 100) - t) < 1e-8);
    let previous = -Infinity;
    for (const rh of [5, 20, 40, 60, 80, 100]) {
      const value = wetBulb(t, rh);
      assert.ok(value <= t + 1e-8 && value >= previous);
      previous = value;
    }
  }
  assert.ok(wetBulb(2, 60, 920) < wetBulb(2, 60, 1013));
  assert.equal(wetBulb(2, 60, 0), null);
  assert.equal(wetBulb(-100, 60), null);
  assert.equal(stationPressure({ cisnienie: 1016 }), 920);
  assert.ok(Math.abs(stationPressure({ stacja: "IBYSTR6", cisnienie: 1013.25 }) - 920.8) < 0.5);
  assert.equal(stationPressure({ cisnienieStacjiHpa: 930 }), 930);
});
