import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze} from '../beepblips.js';

/** 只取音节事件的文本，方便断言。 */
const texts = (plan) => plan.events.filter((e) => e.kind === 'syl').map((e) => e.text);
const syl = (text, opts) => texts(analyze(text, opts));

test('全角字符会先转成半角', () => {
  const plan = analyze('ＡＢＣ，１２３！', {language: 'en'});
  assert.equal(plan.text, 'ABC,123!');
  assert.equal(plan.cues.length, 9); // A B C + one hundred twenty three
  assert.ok(plan.cues.every((c) => /^[A-Za-z]$/.test(c.text) || /^[a-z]+$/.test(c.text)));
});

test('英文句号不再被当成一个音节', () => {
  const plan = analyze('Hello. World.');
  assert.equal(plan.cues.length, 3); // hel lo + world
  assert.ok(plan.cues.every((c) => c.text !== '.'));
  assert.equal(plan.events.filter((e) => e.kind === 'pause').length, 2);
});

test('小数点不会被切成两句', () => {
  const plan = analyze('3.14', {language: 'en'});
  const pauses = plan.events.filter((e) => e.kind === 'pause');
  assert.equal(pauses.length, 1); // 只有句尾那一个停顿
  assert.deepEqual(texts(plan), ['three', 'point', 'one', 'four']);
});

test('逗号只切小句，不切句', () => {
  const plan = analyze('你好，世界。');
  assert.equal(plan.events.filter((e) => e.kind === 'pause').length, 2);
  const pauses = plan.events.filter((e) => e.kind === 'pause');
  assert.ok(Math.abs(pauses[0].t1 - pauses[0].t0 - 0.2) < 1e-9);
  assert.ok(Math.abs(pauses[1].t1 - pauses[1].t0 - 0.38) < 1e-9);
});

test('拉丁词按元音组切音节', () => {
  const cases = {
    beepblips: 2,
    synthesis: 3,
    hello: 2,
    beep: 1,
    table: 2,
    audio: 3,
    queue: 1,
    cake: 1,
    rhythm: 1,
    strengths: 1,
  };
  for (const [word, count] of Object.entries(cases)) {
    assert.equal(analyze(word, {language: 'en'}).cues.length, count, `${word} 应该是 ${count} 个音节`);
  }
});

test('大写缩写按字母名读，可关闭', () => {
  assert.equal(analyze('API', {language: 'en'}).cues.length, 3);
  assert.equal(analyze('API', {language: 'en', readAcronyms: false}).cues.length, 2);
});

test('中文数字按万/亿分组', () => {
  const zh = (n) => analyze(n, {language: 'zh'}).cues.map((c) => c.text).join('');
  assert.equal(zh('0'), '零');
  assert.equal(zh('10'), '十');
  assert.equal(zh('105'), '一百零五');
  assert.equal(zh('10010'), '一万零一十');
  assert.equal(zh('2026'), '二千零二十六');
  assert.equal(zh('100000000'), '一亿');
  assert.equal(zh('3.5'), '三点五');
});

test('英文数字按 thousand/million 读', () => {
  const en = (n) => analyze(n, {language: 'en'}).cues.map((c) => c.text).join('');
  assert.equal(en('0'), 'zero');
  assert.equal(en('10'), 'ten');
  assert.equal(en('105'), 'onehundredfive');
  assert.equal(en('2026'), 'twothousandtwentysix');
  assert.equal(en('3.5'), 'threepointfive');
});

test('表情符号各算一声，假名按モーラ计数，ASCII 标点不发声', () => {
  assert.equal(analyze('❤', {language: 'en'}).cues.length, 1);
  const ja = analyze('こんにちは', {language: 'en'});
  assert.equal(ja.cues.length, 5);
  assert.deepEqual(ja.cues.map((c) => c.vowel), ['o', 'ə', 'i', 'i', 'a']);
  assert.equal(analyze('+&@#', {language: 'en'}).cues.length, 0);
});

test('空文本与纯标点返回空计划', () => {
  for (const text of ['', '   ', '，。！？', '……']) {
    const plan = analyze(text);
    assert.equal(plan.duration, 0, JSON.stringify(text));
    assert.equal(plan.cues.length, 0, JSON.stringify(text));
  }
});

test('数字可以整体关掉读音展开', () => {
  const plan = analyze('42', {language: 'en', readNumbers: false});
  assert.deepEqual(texts(plan), ['4', '2']);
});
