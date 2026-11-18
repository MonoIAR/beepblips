import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze, render, speak, defineVoice} from '../beepblips.js';

const TEXT = '今天吃白饭？没饭了！真的没饭了……';

function stats(samples) {
  let peak = 0;
  let sum = 0;
  let bad = 0;
  for (const v of samples) {
    if (!Number.isFinite(v)) bad += 1;
    if (Math.abs(v) > peak) peak = Math.abs(v);
    sum += v * v;
  }
  return {peak, rms: Math.sqrt(sum / Math.max(1, samples.length)), bad};
}

function mean(samples) {
  let s = 0;
  for (const v of samples) s += v;
  return s / Math.max(1, samples.length);
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** 归一化自相关估基频，用来验证音高真的落在该在的地方。 */
function estimateF0(samples, sr, fromSec, durSec) {
  const from = Math.floor(fromSec * sr);
  const w = samples.subarray(from, from + Math.floor(durSec * sr));
  const minLag = Math.floor(sr / 1000);
  const maxLag = Math.floor(sr / 80);
  const corr = new Float64Array(maxLag + 1);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < w.length; i += 1) sum += w[i] * w[i + lag];
    corr[lag] = sum / (w.length - lag);
    if (corr[lag] > best) best = corr[lag];
  }
  let lag = minLag;
  while (lag <= maxLag && corr[lag] < best * 0.9) lag += 1;
  return sr / lag;
}

test('渲染长度与时长一致', () => {
  const plan = analyze(TEXT);
  const sr = 44100;
  const out = render(plan, {sampleRate: sr});
  assert.equal(out.samples.length, Math.ceil((plan.duration + 0.06) * sr));
  assert.equal(out.sampleRate, sr);
  assert.equal(out.duration, plan.duration);
});

test('音频有限、峰值不超过 1、没有明显直流', () => {
  for (const name of ['bibi', 'warm', 'robot', 'squeak']) {
    const out = speak(TEXT, {voice: name});
    const {peak, rms, bad} = stats(out.samples);
    assert.equal(bad, 0, `${name} 出现 NaN/Infinity`);
    assert.ok(peak > 0.05 && peak <= 1, `${name} 峰值 ${peak}`);
    assert.ok(rms > 0.02, `${name} 太安静（rms ${rms}）`);
    assert.ok(Math.abs(mean(out.samples)) < 1e-3, `${name} 直流偏移 ${mean(out.samples)}`);
  }
});

test('空文本渲染出空采样', () => {
  const out = speak('');
  assert.equal(out.samples.length, 0);
  assert.equal(out.duration, 0);
  assert.equal(out.cues.length, 0);
});

test('同一个种子逐字节相同，换种子会不同', () => {
  const a = speak('啊啊啊', {seed: 1});
  const b = speak('啊啊啊', {seed: 1});
  const c = speak('啊啊啊', {seed: 2});
  assert.ok(same(a.samples, b.samples));
  assert.ok(!same(a.samples, c.samples));
  assert.ok(same(a.plan.cues.map((x) => x.t0), c.plan.cues.map((x) => x.t0)));
});

test('不同声线的波形不同', () => {
  const a = speak('你好世界', {voice: 'bibi'});
  const b = speak('你好世界', {voice: 'warm'});
  assert.ok(!same(a.samples, b.samples));
});

test('任意采样率都不炸', () => {
  const plan = analyze('你好，世界！');
  for (const sr of [8000, 22050, 48000]) {
    const out = render(plan, {sampleRate: sr, reverb: 0.2});
    const {bad, peak} = stats(out.samples);
    assert.equal(bad, 0, `${sr}Hz 出现非法采样`);
    assert.ok(peak <= 1);
  }
});

test('手写 plan 也能渲染，且音高准确', () => {
  const plan = {
    version: 1,
    text: 'a',
    duration: 0.9,
    cues: [],
    events: [{
      kind: 'syl', t0: 0.05, t1: 0.85, text: 'a', wordId: 0,
      vowels: ['a'], onset: {type: 'none'}, coda: null,
      pitch: [0, 0], amp: 1, stress: 0, tone: null, jitter: 0, phraseId: 0,
    }],
  };
  const out = render(plan, {voice: 'bibi', sampleRate: 44100});
  const {peak, bad} = stats(out.samples);
  assert.equal(bad, 0);
  assert.ok(peak > 0.05);
  // register 74 = D5 ≈ 587.33 Hz
  const f0 = estimateF0(out.samples, 44100, 0.3, 0.4);
  assert.ok(Math.abs(f0 - 587.33) / 587.33 < 0.05, `估计频率 ${f0.toFixed(1)}Hz`);
});

test('混响会加长尾巴，且不会产生非法值', () => {
  const plan = analyze('你好。');
  const dry = render(plan, {reverb: 0});
  const wet = render(plan, {reverb: 0.5});
  assert.ok(wet.samples.length > dry.samples.length);
  assert.equal(stats(wet.samples).bad, 0);
});

test('自定义声线的深度合并与校验', () => {
  const v = defineVoice({register: 60, vibrato: {depth: 0.02}});
  assert.equal(v.register, 60);
  assert.equal(v.vibrato.depth, 0.02);
  assert.equal(v.vibrato.rate, 5.6); // 没覆盖的字段保持默认
  assert.throws(() => defineVoice({source: 'noise'}), TypeError);
  assert.throws(() => defineVoice({register: 999}), TypeError);
});

test('非法输入会抛出能看懂的错', () => {
  assert.throws(() => render({}, {}), TypeError);
  assert.throws(() => render(analyze('hi'), {sampleRate: 100}), TypeError);
  assert.throws(() => render(analyze('hi'), {pitch: 'high'}), TypeError);
  assert.throws(() => speak('hi', {voice: 'nobody'}), /未知声线/);
});
