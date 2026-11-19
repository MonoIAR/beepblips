import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze, speak} from '../beepblips.js';

const cues = (text, opts) => analyze(text, opts).cues;
const vowels = (text, opts) => cues(text, opts).map((c) => c.vowel);
const syllables = (plan) => plan.events.filter((e) => e.kind === 'syl');

/** 把音节和促音的静音拼回假名串，方便断言「读出来是什么」。 */
const mora = (text, opts) => analyze(text, opts).events
  .filter((e) => e.kind === 'syl' || (e.kind === 'pause' && e.after === 'mora'))
  .map((e) => e.text ?? e.reason)
  .join('');

test('假名按モーラ切分，元音取自五十音', () => {
  const plan = analyze('こんにちは');
  assert.equal(plan.language, 'ja');
  assert.deepEqual(plan.cues.map((c) => c.text), ['こ', 'ん', 'に', 'ち', 'は']);
  assert.deepEqual(vowels('こんにちは'), ['o', 'ə', 'i', 'i', 'a']);
  // 五十音的行就是声母：か行是塞音，さ行是擦音，ま/な行是鼻音，や/ら/わ 是流音
  assert.deepEqual(cues('かさなまやら').map((c) => c.onset),
    ['stop', 'fric', 'nasal', 'nasal', 'liquid', 'liquid']);
  assert.equal(cues('あ')[0].onset, 'none');
});

test('片假名与平假名走同一张表', () => {
  assert.deepEqual(vowels('コーヒー'), vowels('こーひー'));
  assert.deepEqual(vowels('カタカナ'), ['a', 'a', 'a', 'a']);
  assert.deepEqual(vowels('ヴァイオリン'), ['a', 'i', 'o', 'i', 'ə']);
});

test('拗音只占一拍', () => {
  assert.equal(cues('きょう').length, 2); // きょ + う
  assert.equal(cues('しゃしん').length, 3); // しゃ + し + ん
  const kya = cues('きゃ')[0];
  assert.equal(kya.vowel, 'a');
  assert.equal(kya.onset, 'stop');
  const sha = cues('しゃ')[0];
  assert.equal(sha.vowel, 'a');
  assert.equal(sha.onset, 'fric');
});

test('长音把前一拍再拖一拍', () => {
  const plan = analyze('コーヒーです');
  const evs = syllables(plan);
  assert.deepEqual(evs.map((e) => e.text), ['コ', 'ヒ', 'で', 'す']);
  assert.equal(evs[0].moras, 2);
  assert.equal(evs[1].moras, 2);
  const dur = (e) => e.t1 - e.t0;
  // コー と ヒー 都是普通拍的两倍，で 是一倍，す 在句尾会稍微拖长
  assert.ok(Math.abs(dur(evs[0]) - 2 * dur(evs[2])) < 1e-9);
  assert.ok(Math.abs(dur(evs[1]) - 2 * dur(evs[2])) < 1e-9);
  assert.ok(dur(evs[3]) > dur(evs[2]));
});

test('促音占一整拍静音，承前启后', () => {
  const plan = analyze('がっこう');
  assert.equal(mora('がっこう'), 'がっこう');
  assert.deepEqual(plan.cues.map((c) => c.text), ['が', 'こ', 'う']);
  const hold = plan.events.find((e) => e.kind === 'pause' && e.after === 'mora');
  assert.ok(hold, '找不到促音的静音事件');
  assert.equal(hold.reason, 'っ');
  const base = 1 / plan.tempo;
  assert.ok(Math.abs(hold.t1 - hold.t0 - base) < 1e-9);
  // 静音落在 が 和 こ 之间
  assert.ok(hold.t0 >= syllables(plan)[0].t1 - 1e-9);
});

test('普通モーラ等长（等モーラ节奏）', () => {
  const evs = syllables(analyze('さくらをみます'));
  const durs = evs.slice(0, -1).map((e) => e.t1 - e.t0);
  assert.ok(Math.max(...durs) - Math.min(...durs) < 1e-9, `时长 ${durs.join(', ')}`);
  assert.ok(evs.at(-1).t1 - evs.at(-1).t0 > durs[0]);
});

test('拨音是整拍鼻音', () => {
  const evs = syllables(analyze('しんぶん'));
  assert.deepEqual(evs.map((e) => e.text), ['し', 'ん', 'ぶ', 'ん']);
  for (const i of [1, 3]) {
    assert.equal(evs[i].nasalOnly, true);
    assert.equal(evs[i].onset.type, 'nasal');
  }
  assert.equal(evs[2].onset.type, 'stop');
});

test('を 念 o，不念 wo', () => {
  const cue = cues('を')[0];
  assert.equal(cue.vowel, 'o');
  assert.equal(cue.onset, 'none');
});

test('认不出来的假名当标点跳过', () => {
  assert.equal(cues('あ・い').length, 2);
  assert.equal(cues('コーヒー・ゲーム').length, 4);
  // 只有促音/长音的文本没有真音节，和纯标点一样安静
  for (const text of ['っ', 'ッ', 'ー']) {
    const plan = analyze(text);
    assert.equal(plan.cues.length, 0, text);
    assert.equal(plan.duration, 0, text);
  }
});

test('假名的音高不带字调，标点照常指挥语气', () => {
  const flat = syllables(analyze('こんにちは'));
  assert.ok(flat.every((e) => e.tone === null));
  const pitch = (text) => syllables(analyze(text)).at(-1).pitch;
  const up = pitch('そうですか？');
  const down = pitch('そうですか。');
  assert.ok(up.at(-1) > down.at(-1) + 6, `问句 ${up.at(-1)} 应该明显高于陈述 ${down.at(-1)}`);
});

test('假名混排拉丁文、汉字都不炸', () => {
  const plan = analyze('すしを たべます。hello 日本');
  assert.equal(plan.language, 'ja');
  assert.equal(plan.warnings.length, 0);
  const kinds = syllables(plan).map((e) => e.kindOf);
  assert.ok(kinds.includes('kana') && kinds.includes('latin') && kinds.includes('cjk'));
});

test('日语数字读成假名，再走假名前端', () => {
  assert.equal(mora('2026', {language: 'ja'}), 'にせんにじゅうろく');
  assert.equal(mora('300', {language: 'ja'}), 'さんびゃく');
  assert.equal(mora('600', {language: 'ja'}), 'ろっぴゃく');
  assert.equal(mora('8000', {language: 'ja'}), 'はっせん');
  assert.equal(mora('10010', {language: 'ja'}), 'いちまんじゅう');
  assert.equal(mora('3.5', {language: 'ja'}), 'さんてんご');
  // 没有数字的假名文本自动就是 ja
  assert.equal(analyze('にせん').language, 'ja');
});

test('拉丁文和拼音不受影响', () => {
  assert.deepEqual(vowels('hello'), ['e', 'o']);
  const pinyin = analyze('ni3 hao3');
  assert.equal(pinyin.mode, 'pinyin');
  assert.deepEqual(pinyin.cues.map((c) => c.vowel), ['i', 'a']);
});

test('假名分析是确定的，且能渲染出声音', () => {
  const text = 'おはよう！きょうも はれですね。カフェで コーヒーを のみましょう！';
  assert.equal(JSON.stringify(analyze(text)), JSON.stringify(analyze(text)));

  const out = speak(text);
  assert.ok(out.samples.length > 0);
  assert.equal(out.duration, out.plan.duration);
  let peak = 0;
  for (const v of out.samples) {
    assert.ok(Number.isFinite(v), '出现了非法采样');
    peak = Math.max(peak, Math.abs(v));
  }
  assert.ok(peak > 0.05 && peak <= 1, `峰值 ${peak}`);
  assert.equal(out.cues.length, out.plan.cues.length);
});
