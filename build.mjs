// 把 beepblips.js 内联进 index.html，让网页双击就能用（不需要服务器、不需要 import）。
//
//   node build.mjs           写入
//   node build.mjs --check   只检查是否同步（CI / 测试用）

import {readFileSync, writeFileSync} from 'node:fs';
import {Script} from 'node:vm';

const BEGIN = '/* beepblips:begin */';
const END = '/* beepblips:end */';

const engineUrl = new URL('./beepblips.js', import.meta.url);
const htmlUrl = new URL('./index.html', import.meta.url);

const engine = readFileSync(engineUrl, 'utf8');
// 内联后和演示代码同处一个 module，直接把 export 去掉即可
const inline = engine.replace(/^export /gm, '').trimEnd();

if (/\bimport\s|\bexport\s/.test(inline)) {
  console.error('引擎里还有 import/export，无法安全内联');
  process.exit(1);
}
try {
  new Script(inline);
} catch (err) {
  console.error(`引擎去掉 export 后无法解析：${err.message}`);
  process.exit(1);
}

const html = readFileSync(htmlUrl, 'utf8');
const start = html.indexOf(BEGIN);
const end = html.indexOf(END);
if (start < 0 || end < start) {
  console.error('index.html 里找不到 beepblips:begin / beepblips:end 标记');
  process.exit(1);
}

const next = `${html.slice(0, start + BEGIN.length)}\n${inline}\n  ${html.slice(end)}`;

if (process.argv.includes('--check')) {
  if (next !== html) {
    console.error('index.html 与 beepblips.js 不同步，请运行：node build.mjs');
    process.exit(1);
  }
  console.log('index.html 与 beepblips.js 同步');
  process.exit(0);
}

if (next === html) {
  console.log('index.html 已是最新');
} else {
  writeFileSync(htmlUrl, next);
  console.log('index.html 已更新');
}
