#!/usr/bin/env node
// beepblips 命令行：文本 → WAV。零依赖，只用 Node 内置模块。
//
//   beepblips "今天吃白饭？没饭了！" -o out.wav
//   beepblips --mode pinyin "ni3 hao3" --voice warm --reverb 0.25
//   beepblips "hi" --cues        # 打印音节时间轴
//   beepblips "hi" --json        # 打印乐谱

import {readFileSync, writeFileSync} from 'node:fs';
import {parseArgs} from 'node:util';
import {speak, toWav} from './beepblips.js';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const USAGE = `beepblips ${pkg.version} —— 把一句话变成「哔哔啵啵」

用法：
  beepblips [选项] "要说的文本"

选项：
  -o, --out <文件>    输出 WAV 路径（默认 beepblips.wav）
      --voice <名字>  声线：bibi | warm | robot | squeak（默认 bibi）
      --tempo <数字>  每秒几个音节（默认取声线设置，约 6–8）
      --pitch <半音>  整体移调（默认 0）
      --mode <模式>   auto | text | pinyin（默认 auto）
      --lang <语言>   auto | zh | en | ja（影响数字读法，默认 auto）
      --rate <Hz>     采样率（默认 44100）
      --seed <数字>   抖动/噪声种子（默认 0，同样的种子结果完全一致）
      --reverb <0..1> 混响湿声（默认 0）
      --cues          打印音节时间轴
      --json          打印乐谱 JSON（仍然会渲染音频）
  -h, --help          显示本帮助
  -v, --version       显示版本

例子：
  beepblips "今天吃白饭？没饭了！" -o out.wav
  beepblips --mode pinyin "ni3 hao3" -o hi.wav --cues
  beepblips "こんにちは、きょうも はれですね" -o ja.wav --cues
  beepblips "hello, world" --voice robot --reverb 0.2`;

const OPTIONS = {
  out: {type: 'string', short: 'o', default: 'beepblips.wav'},
  voice: {type: 'string'},
  tempo: {type: 'string'},
  pitch: {type: 'string'},
  mode: {type: 'string'},
  lang: {type: 'string'},
  rate: {type: 'string'},
  seed: {type: 'string'},
  reverb: {type: 'string'},
  cues: {type: 'boolean', default: false},
  json: {type: 'boolean', default: false},
  help: {type: 'boolean', short: 'h', default: false},
  version: {type: 'boolean', short: 'v', default: false},
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({args: process.argv.slice(2), allowPositionals: true, options: OPTIONS});
} catch (err) {
  console.error(`参数错误：${err.message}\n`);
  console.error(USAGE);
  process.exit(1);
}

const {values, positionals} = parsed;
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values.version) {
  console.log(`${pkg.name} ${pkg.version}`);
  process.exit(0);
}

const text = positionals.join(' ').trim();
if (!text) fail(`没有要说的文本。\n\n${USAGE}`);

const num = (raw, name, fallback) => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`--${name} 需要一个数字，收到 "${raw}"`);
  return n;
};

const opts = {
  voice: values.voice,
  tempo: num(values.tempo, 'tempo', undefined),
  pitch: num(values.pitch, 'pitch', 0),
  mode: values.mode ?? 'auto',
  language: values.lang ?? 'auto',
  sampleRate: num(values.rate, 'rate', 44100),
  seed: num(values.seed, 'seed', 0),
  reverb: num(values.reverb, 'reverb', 0),
};

let result;
try {
  result = speak(text, opts);
} catch (err) {
  console.error(`合成失败：${err.message}`);
  process.exit(2);
}

if (values.json) {
  console.log(JSON.stringify(result.plan, null, 2));
  process.exit(0);
}

if (values.cues) {
  console.log('   #  起止(s)        文本      元音      音高');
  for (const cue of result.cues) {
    console.log(`${String(cue.i + 1).padStart(4)}  ${cue.t0.toFixed(2)}–${cue.t1.toFixed(2)}`
      + `  ${cue.text.padEnd(8)} ${cue.vowel.padEnd(8)} ${(cue.midi ?? 0).toFixed(1)}`);
  }
  console.log('');
}

try {
  writeFileSync(values.out, toWav(result.samples, result.sampleRate));
} catch (err) {
  console.error(`写文件失败：${err.message}`);
  process.exit(2);
}

const seconds = result.samples.length / result.sampleRate;
console.log(`${values.out}：${seconds.toFixed(2)} 秒，${result.cues.length} 声，`
  + `${result.plan.text.length} 字，声线 ${opts.voice ?? 'bibi'}`);
if (result.plan.warnings.length) {
  for (const warning of result.plan.warnings) console.warn(`提示：${warning}`);
}
if (result.plan.truncated) console.warn('提示：文本超过 maxDuration，已截断。');
