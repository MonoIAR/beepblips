import test from 'node:test';
import assert from 'node:assert/strict';
import {toWav} from '../beepblips.js';

function header(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n));
  return {
    riff: str(0, 4),
    riffSize: view.getUint32(4, true),
    wave: str(8, 4),
    fmt: str(12, 4),
    fmtSize: view.getUint32(16, true),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    rate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bits: view.getUint16(34, true),
    data: str(36, 4),
    dataSize: view.getUint32(40, true),
  };
}

test('WAV 头字段正确', () => {
  const n = 1000;
  const bytes = toWav(new Float32Array(n), 44100);
  const h = header(bytes);
  assert.equal(h.riff, 'RIFF');
  assert.equal(h.wave, 'WAVE');
  assert.equal(h.fmt, 'fmt ');
  assert.equal(h.data, 'data');
  assert.equal(h.riffSize, 36 + n * 2);
  assert.equal(h.dataSize, n * 2);
  assert.equal(h.fmtSize, 16);
  assert.equal(h.format, 1);
  assert.equal(h.channels, 1);
  assert.equal(h.rate, 44100);
  assert.equal(h.byteRate, 44100 * 2);
  assert.equal(h.blockAlign, 2);
  assert.equal(h.bits, 16);
  assert.equal(bytes.length, 44 + n * 2);
  assert.ok(bytes instanceof Uint8Array);
});

test('采样被钳到 16 位范围', () => {
  const bytes = toWav(new Float32Array([1.5, -1.5, 0.5, 0, Number.NaN]), 8000);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32767);
  assert.equal(view.getInt16(48, true), 16384);
  assert.equal(view.getInt16(50, true), 0);
  assert.equal(view.getInt16(52, true), 0);
});

test('采样率会写进头部', () => {
  for (const sr of [8000, 22050, 48000]) {
    assert.equal(header(toWav(new Float32Array(10), sr)).rate, sr);
  }
});

test('非法采样率报错', () => {
  assert.throws(() => toWav(new Float32Array(10), 0), TypeError);
  assert.throws(() => toWav(new Float32Array(10), -1), TypeError);
});
