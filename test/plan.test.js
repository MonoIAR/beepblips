import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze, mouthOf} from '../beepblips.js';

const syllables = (plan) => plan.events.filter((e) => e.kind === 'syl');

test('同样输入得到同样的计划（确定性）', () => {
  const text = '今天吃白饭？没饭了！真的没饭了……算了，随便吧。';
  assert.equal(JSON.stringify(analyze(text)), JSON.stringify(analyze(text)));
  assert.equal(JSON.stringify(analyze('ni3 hao3')), JSON.stringify(analyze('ni3 hao3')));
});

test('时间轴有序、不重叠、总长一致', () => {
  const plan = analyze('今天吃白饭？没饭了！真的没饭了……算了，随便吧。');
  let last = -Infinity;
  for (const ev of plan.events) {
    assert.ok(Number.isFinite(ev.t0) && Number.isFinite(ev.t1));
    assert.ok(ev.t1 > ev.t0);
    assert.ok(ev.t0 >= last - 1e-9);
    last = ev.t0;
  }
  const end = Math.max(...plan.events.map((e) => e.t1));
  assert.ok(plan.duration >= end - 1e-9);
  assert.ok(plan.duration < end + 1);
});

test('问句末尾上扬，陈述句末尾下落，省略句更低', () => {
  const slope = (plan) => {
    const ev = syllables(plan).at(-1);
    return ev.pitch.at(-1) - ev.pitch[0];
  };
  const question = slope(analyze('啊？'));
  const statement = slope(analyze('啊。'));
  const ellipsis = slope(analyze('啊……'));
  assert.ok(question > statement + 6, `问句斜率 ${question} 应明显大于陈述 ${statement}`);
  assert.ok(ellipsis < statement, `省略句斜率 ${ellipsis} 应小于陈述 ${statement}`);
  const endPitch = (plan) => syllables(plan).at(-1).pitch.at(-1);
  assert.ok(endPitch(analyze('啊……')) < endPitch(analyze('啊。')) - 1);
});

test('句末音节被拖长，重读音节更短', () => {
  const plan = analyze('啊啊啊。');
  const evs = syllables(plan);
  const dur = (e) => e.t1 - e.t0;
  assert.ok(dur(evs.at(-1)) > 1.5 * dur(evs[0]));
  const hello = syllables(analyze('hello'));
  assert.ok(hello[0].stress === 1 && hello[1].stress === 0);
  assert.ok(hello[0].pitch[0] > hello[1].pitch[0] + 1);
});

test('cues 数量与音节一致，口型在 0..1', () => {
  const plan = analyze('今天吃白饭？');
  assert.equal(plan.cues.length, syllables(plan).length);
  for (const cue of plan.cues) {
    assert.ok(cue.t1 > cue.t0);
    assert.ok(cue.mouth.open >= 0 && cue.mouth.open <= 1);
    assert.ok(cue.mouth.wide >= 0 && cue.mouth.wide <= 1);
    assert.equal(typeof cue.vowel, 'string');
  }
  assert.deepEqual(mouthOf('a'), {open: 1, wide: 0.26666666666666666});
});

test('哈希的各个维度互相解耦（不会只剩五种声音）', () => {
  const text = Array.from({length: 200}, (_, i) => String.fromCharCode(0x4e00 + i)).join('');
  const pairs = new Set(analyze(text).cues.map((c) => `${c.vowel}/${c.tone}`));
  assert.ok(pairs.size >= 25, `200 个不同汉字只产生了 ${pairs.size} 种口型/声调组合`);
});

test('拼音模式：声母、韵母、声调', () => {
  const plan = analyze('ni3 hao3');
  assert.equal(plan.mode, 'pinyin');
  const evs = syllables(plan);
  assert.equal(evs.length, 2);
  assert.deepEqual(evs[0].vowels, ['i']);
  assert.equal(evs[0].tone, 3);
  assert.equal(evs[0].onset.type, 'nasal'); // n 是声母
  assert.deepEqual(evs[1].vowels, ['a', 'u']);
  assert.equal(evs[1].tone, 3);
  assert.equal(syllables(analyze('ai4'))[0].onset.type, 'none'); // 零声母

  const marked = syllables(analyze('hǎo'));
  assert.deepEqual(marked[0].vowels, ['a', 'u']);
  assert.equal(marked[0].tone, 3);

  const zhong = syllables(analyze('zhong1 guo2'));
  assert.equal(zhong.length, 2);
  assert.equal(zhong[0].onset.type, 'stop');
  assert.equal(zhong[0].coda, 'ng');
  assert.deepEqual(zhong[0].vowels, ['o']);
});

test('拼音模式可以自动识别，普通英文不会被误判', () => {
  assert.equal(analyze('ni3 hao3').mode, 'pinyin');
  assert.equal(analyze('ni3 hao3', {mode: 'auto'}).mode, 'pinyin');
  assert.equal(analyze('hello world').mode, 'text');
  assert.equal(analyze('ni hao').mode, 'text'); // 没有声调，按普通文本
});

test('拼音解析失败会回退并给出 warning', () => {
  const plan = analyze('ni3 hello', {mode: 'pinyin'});
  assert.equal(plan.warnings.length, 1);
  assert.equal(plan.cues.length, 3); // ni + hel lo
});

test('maxDuration 会截断并在计划里标记', () => {
  const text = '很长的一段话'.repeat(60);
  const plan = analyze(text, {maxDuration: 1});
  assert.equal(plan.truncated, true);
  assert.ok(plan.duration <= 1.5, `实际 ${plan.duration}`);
});

test('未知 mode 直接报错', () => {
  assert.throws(() => analyze('hi', {mode: 'sing'}), TypeError);
});
