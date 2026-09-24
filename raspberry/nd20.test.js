const { test } = require("node:test");
const assert = require("node:assert/strict");
const { decodeRegisters } = require("./nd20.js");

test("ND20: kolejność słów float i mapa mocy trójfazowej", () => {
  const words = Array(66).fill(0);
  const put = (offset, value) => {
    const b = Buffer.alloc(4);
    b.writeFloatBE(value);
    words[offset] = b.readUInt16BE(0);
    words[offset + 1] = b.readUInt16BE(2);
  };
  put(0, 230);
  put(2, 125);
  put(46, 74250);
  put(56, 50);
  put(58, 400);
  const result = decodeRegisters(words);
  assert.equal(result.napiecieL1, 230);
  assert.equal(result.pradL1, 125);
  assert.equal(result.mocKw, 74.25);
  assert.equal(result.czestotliwoscHz, 50);
  assert.equal(result.napiecieL1L2, 400);
});

test("ND20: niepełna odpowiedź lub wartości alarmowe nie udają pomiaru", () => {
  assert.throws(() => decodeRegisters([1, 2]));
  const words = Array(66).fill(0);
  const alarm = Buffer.alloc(4);
  alarm.writeFloatBE(1e20);
  words[56] = alarm.readUInt16BE(0);
  words[57] = alarm.readUInt16BE(2);
  assert.equal(decodeRegisters(words).czestotliwoscHz, null);
});
