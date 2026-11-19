import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze, speak, render} from '../beepblips.js';

const ON = {noteMarks: 'auto'};
const syllables = (plan) => plan.events.filter((e) => e.kind === 'syl');
const noteOf = (plan) => syllables(plan).map((ev) => ev.notes ?? null);

/** 归一化自相关估基频，用来验证音名真的落在了该在的频率上。 */
function estimateF0(samples, sr, fromSec, durSec) {
  const from = Math.floor(fromSec * sr);
  const w = samples.subarray(from, from + Math.floor(durSec * sr));
  const minLag = Math.floor(sr / 1000);
  const maxLag = Math.floor(sr / 80);
  let best = -Infinity;
  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < w.length; i += 1) sum += w[i] * w[i + lag];
    sum /= w.length - lag;
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return sr / bestLag;
}

test('默认关闭：方括号仍按普通文本读，和以前逐字节一致', () => {
  const plan = analyze('あ[C4]');
  assert.equal(plan.text, 'あ C4'); // 方括号被当空格，音名照旧念出来
  assert.equal(JSON.stringify(plan), JSON.stringify(analyze('あ C4')));
  assert.deepEqual(plan.cues.map((c) => c.text), ['あ', 'c', 'よ', 'ん']);
  assert.ok(!JSON.stringify(plan).includes('"notes"'));
  assert.ok(!plan.cues.some((c) => 'note' in c));
  assert.equal(plan.register, undefined);
});

test('打开后每个字按音名发声，锚点是相对 register 的半音', () => {
  const plan = analyze('あ[C4]い[D4]う[E4]', ON);
  assert.equal(plan.text, 'あ[C4]い[D4]う[E4]');
  assert.equal(plan.register, 74); // bibi 的音域
  const evs = syllables(plan);
  assert.equal(evs.length, 3);
  assert.deepEqual(noteOf(plan), [[60], [62], [64]]);
  assert.deepEqual(evs.map((ev) => ev.pitch), [[-14], [-12], [-10]]);
  assert.deepEqual(plan.cues.map((c) => c.note), ['C4', 'D4', 'E4']);
});

test('音名是绝对音高：换声线 C4 还是 C4', () => {
  for (const voice of ['bibi', 'warm', 'robot', 'squeak']) {
    const out = speak('あ[C4]い[D4]う[E4]', {...ON, voice});
    assert.deepEqual(out.cues.map((c) => Math.round(c.midi)), [60, 62, 64], `${voice} 跑调了`);
  }
});

test('实际频率对得上音名（C4 ≈ 261.63 Hz）', () => {
  const out = speak('あ[C4]', {...ON, tempo: 2, voice: 'bibi'});
  const f0 = estimateF0(out.samples, out.sampleRate, 0.2, 0.3);
  assert.ok(Math.abs(f0 - 261.63) / 261.63 < 0.02, `估计频率 ${f0.toFixed(1)}Hz`);
});

test('没写音名的音节保持原样（语调照算）', () => {
  const plain = syllables(analyze('あい。', ON));
  const mixed = syllables(analyze('あ[C4]い。', ON));
  assert.deepEqual(mixed[0].pitch, [60 - 74]);
  assert.deepEqual(mixed[1].pitch, plain[1].pitch);
  assert.equal(mixed[1].notes, undefined);
});

test('连写多个音名 = 同一音节内的滑音', () => {
  const plan = analyze('あ[C4][E4]', ON);
  assert.deepEqual(syllables(plan)[0].pitch, [-14, -10]);
  assert.equal(plan.cues[0].note, 'C4'); // cue 显示起点
});

test('全角方括号、小写、降号、连字符都认', () => {
  assert.deepEqual(noteOf(analyze('あ［c4］', ON)), [[60]]);
  assert.deepEqual(noteOf(analyze('あ[Bb4]', ON)), [[70]]);
  assert.deepEqual(noteOf(analyze('あ[F#3]', ON)), [[54]]);
  assert.deepEqual(noteOf(analyze('あ[A4]', ON)), [[69]]);
  assert.deepEqual(noteOf(analyze('あ[C-1]', ON)), [[0]]);
});

test('认不出的音名只记 warning，不会多念一个字', () => {
  const plan = analyze('あ[H4]', ON);
  assert.equal(plan.cues.length, 1);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /\[H4\]/);
  assert.equal(analyze('あ[C10]', ON).warnings.length, 1); // 超出 127
});

test('标记钉在它前面最近的有声字符上（促音、长音、拗音）', () => {
  const sokuon = analyze('がっ[C4]こう', ON);
  assert.deepEqual(sokuon.cues.map((c) => c.text), ['が', 'こ', 'う']);
  assert.equal(sokuon.cues[0].note, 'C4');

  const chouon = analyze('コー[C4]', ON);
  assert.deepEqual(chouon.cues.map((c) => c.text), ['コ']);
  assert.equal(chouon.cues[0].note, 'C4');
  assert.ok(chouon.cues[0].t1 - chouon.cues[0].t0 > 0.3); // 仍然是两拍

  assert.deepEqual(noteOf(analyze('きゃ[C4]', ON)), [[60]]);
});

test('拼音词尾的音名标记，自动识别也不受影响', () => {
  const plan = analyze('ni3[C4] hao3[D4]', ON);
  assert.equal(plan.mode, 'pinyin');
  assert.deepEqual(plan.cues.map((c) => c.note), ['C4', 'D4']);
  assert.equal(plan.cues[1].tone, 3); // 声调信息还在，只是不叠加到音高

  // 非拼音词回退到普通文本时，标记照样生效
  const fallback = analyze('hello[C4]', {mode: 'pinyin', noteMarks: 'auto'});
  assert.equal(fallback.warnings.length, 1);
  assert.equal(fallback.cues[0].note, 'C4');
});

test('拉丁词和数字：标记落在第一个音节上', () => {
  const word = analyze('hello[C4]', ON);
  assert.equal(word.cues.length, 2);
  assert.equal(word.cues[0].note, 'C4');
  assert.equal(word.cues[1].note, undefined);

  const num = analyze('12[C4]', {...ON, language: 'en'});
  assert.equal(num.cues[0].text, 'twelve');
  assert.equal(num.cues[0].note, 'C4');
});

test('标记前面没有字符时只报警告', () => {
  const plan = analyze('[C4]あ', ON);
  assert.equal(plan.cues.length, 1);
  assert.equal(plan.cues[0].note, undefined);
  assert.ok(plan.warnings.some((w) => w.includes('前面没有可发声的字符')));
});

test('plan 只在用到音名时才带 register', () => {
  assert.equal(analyze('あ[C4]', ON).register, 74);
  assert.equal(analyze('あ', ON).register, undefined);
  assert.ok(!('register' in analyze('あ', ON)));
  assert.equal(analyze('あ[C4]', {...ON, register: 60}).events[0].pitch[0], 0);
});

test('同样的输入得到同样的计划（确定性）', () => {
  assert.equal(
    JSON.stringify(analyze('あ[C4]い[D4]', ON)),
    JSON.stringify(analyze('あ[C4]い[D4]', ON)),
  );
});

test('换声线渲染会整体平移，音名跟着 register 走', () => {
  const plan = analyze('あ[C4]', ON); // 按 bibi 74 换算：-14
  assert.deepEqual(render(plan, {voice: 'bibi'}).cues.map((c) => c.midi), [60]);
  assert.deepEqual(render(plan, {voice: 'warm'}).cues.map((c) => c.midi), [43]); // 57 - 14
});

test('非法选项抛 TypeError', () => {
  assert.throws(() => analyze('hi', {noteMarks: 'on'}), TypeError);
  assert.throws(() => analyze('hi', {register: 200}), TypeError);
  assert.throws(() => analyze('hi', {register: 'high'}), TypeError);
});
