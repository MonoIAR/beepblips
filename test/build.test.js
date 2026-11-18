import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('index.html 内联的引擎与 beepblips.js 同步', () => {
  const out = spawnSync(process.execPath, [fileURLToPath(new URL('../build.mjs', import.meta.url)), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr || out.stdout);
});

test('演示页引用的 DOM id 都存在且不重复', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML 里有重复 id');

  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match, 'index.html 里找不到内联 module');
  const code = match[1];
  const refs = new Set();
  for (const ref of code.matchAll(/\$\('([^']+)'\)/g)) refs.add(ref[1]);
  for (const ref of code.matchAll(/(?:setText|setValue)\('([^']+)'/g)) refs.add(ref[1]);
  for (const id of refs) assert.ok(ids.includes(id), `DOM 引用 "${id}" 没有对应元素`);
});

test('演示页的脚本能在最小 DOM 里跑完一次合成', () => {
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match, 'index.html 里找不到内联 module');
  const code = match[1];
  const listeners = () => {
    const map = new Map();
    const fn = (type, handler) => {
      if (!map.has(type)) map.set(type, []);
      map.get(type).push(handler);
    };
    fn.map = map;
    return fn;
  };

  const ctxStub = () => new Proxy({}, {
    get: (target, key) => (key in target ? target[key] : () => {}),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });

  const nodes = new Map();
  const initial = {
    text: '今天吃白饭？没饭了！',
    voice: 'bibi',
    mode: 'auto',
    language: 'auto',
    'sample-rate': '44100',
    seed: '0',
    tempo: '7',
    pitch: '0',
    reverb: '0',
    'pause-scale': '1',
    'max-duration': '600',
    wave: '',
    mouths: '',
  };
  const node = (id) => {
    if (nodes.has(id)) return nodes.get(id);
    const element = {
      id,
      value: id in initial ? initial[id] : '',
      textContent: '',
      innerHTML: '',
      hidden: false,
      style: {},
      dataset: {},
      width: 0,
      height: 0,
      clientWidth: 720,
      clientHeight: id === 'mouths' ? 96 : 120,
      addEventListener: listeners(),
      removeAttribute() {},
      getContext: ctxStub,
      play: () => Promise.resolve(),
      pause() {},
      click() {},
      currentTime: 0,
      duration: 2,
    };
    nodes.set(id, element);
    return element;
  };

  const document = {
    getElementById: node,
    createElement: () => node(`created-${nodes.size}`),
    querySelectorAll: () => [],
  };
  const window = {addEventListener() {}, devicePixelRatio: 1};

  const run = new Function('document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', 'Blob', 'URL',
    `${code}\n//# sourceURL=index.html`);
  run(document, window, () => 0, () => {}, Blob, URL);

  const stats = nodes.get('stats');
  assert.ok(stats, '统计行没有被写入');
  assert.match(stats.innerHTML, /\d+<\/b> syllables/);
  assert.match(stats.innerHTML, /mode <b>text<\/b>/);

  const plan = nodes.get('plan-json');
  assert.ok(plan, '评分 JSON 没有被写入');
  assert.match(plan.textContent, /"version": 1/);

  const cues = nodes.get('cue-body');
  assert.ok(cues, '口型表没有被写入');
  assert.match(cues.innerHTML, /<tr><td>1<\/td>/);
});
