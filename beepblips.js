// beepblips.js
// 一条锯齿波过三个共振峰、一个字一声、标点管语气、同字同声；
// 再加上文本分析（分词/数字/音节/拼音）、连续音高与字间共音、
// 辅音手势、可深度定制的声线、时间轴 cues、软限幅与可选混响。
// 可选的手动音高：把音名写进文本（あ[C4]い[D4]），规划期换算成相对半音，渲染不用改。
//
// 流程：normalize → segment → tokenize → 读音展开 → 韵律（Plan）→ 单通道合成 → WAV。
// 所有音色与韵律参数都是数据，改声线不用碰 DSP。
// (c) 2026 MIAR STAFF, beepblips contributors.

// ─────────────────────────── 1. 数值与哈希 ───────────────────────────

const TAU = Math.PI * 2;

/** MIDI 音高 → 频率。 */
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const lerp = (a, b, t) => a + (b - a) * t;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** FNV-1a，32 位。同一个字永远得到同一个数。 */
export function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 把 32 位数打散，让不同“维度”（音高/元音/辅音/抖动）互不相关。 */
function mix32(x) {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** 从 seed 的某个维度里取 0..n-1，同一个 seed 永远同一个结果。 */
const pick = (seed, salt, n) => mix32((seed ^ salt) >>> 0) % n;

/** -1..1 的确定性抖动。 */
const unit = (seed, salt) => (mix32((seed ^ salt) >>> 0) / 4294967296) * 2 - 1;

/** 可复现的伪随机数（噪声、混响抖动用）。 */
function mulberry32(a) {
  let s = a >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────── 2. 音色数据 ───────────────────────────

/** 元音 = 三个共振峰频率（Hz）。前两个决定口型，第三个决定“亮”。 */
export const VOWELS = Object.freeze({
  a: [800, 1200, 2600],
  e: [500, 1900, 2550],
  i: [300, 2300, 3000],
  o: [500, 900, 2400],
  u: [340, 750, 2350],
  y: [300, 1850, 2300],
  'ə': [500, 1500, 2500],
  'æ': [700, 1600, 2600],
  'ɛ': [600, 1900, 2600],
  apical: [420, 1350, 2700],
});

/** 语调默认值（可以被 analyze 的 contours / 声线的 contours 覆盖）。 */
const DEFAULT_CONTOURS = Object.freeze({
  decline: [1.0, -1.5],
  comma: 1.2,
  question: 5,
  exclaim: 1.5,
  statement: -2.5,
  ellipsis: -4.5,
  accent: 1.5,
  cjkAccent: 1.0,
});

/** 汉语声调轮廓（相对半音，三个锚点）。 */
const TONE_SHAPES = Object.freeze({
  1: [0, 0, 0],
  2: [-1.5, -0.5, 2.5],
  3: [0, -3.5, -1],
  4: [2.5, 0, -3],
  0: [0, -0.5, -1],
});

/** 声线。全部是数据：register 音高、formantScale 声道长度、contours 语调。 */
export const VOICES = {
  // 明亮的小人，默认声线
  bibi: {
    register: 74,
    tempo: 7,
    formantScale: 1.18,
    tilt: 0.45,
    breath: 0.05,
    jitter: 0.1,
    vibrato: {rate: 5.6, depth: 0.009, onset: 0.09},
    source: 'saw',
    pulseWidth: 0.3,
    articulation: {consonant: 1, attack: 0.006, release: 0.026},
    drive: 2,
    gain: 0.45,
    reverb: 0,
    contours: {...DEFAULT_CONTOURS},
  },
  // 低沉、温和，句尾容易往下落
  warm: {
    register: 57,
    tempo: 6,
    formantScale: 0.94,
    tilt: 0.62,
    breath: 0.09,
    jitter: 0.12,
    vibrato: {rate: 5, depth: 0.012, onset: 0.1},
    source: 'saw',
    pulseWidth: 0.3,
    articulation: {consonant: 0.85, attack: 0.008, release: 0.04},
    drive: 1.7,
    gain: 0.6,
    reverb: 0,
    contours: {decline: [0.6, -2.2], comma: 0.8, question: 4, exclaim: 1, statement: -3, ellipsis: -5, accent: 1.2, cjkAccent: 0.8},
  },
  // 方波脉冲、没有颤音，机械感
  robot: {
    register: 62,
    tempo: 7.6,
    formantScale: 1.05,
    tilt: 0.22,
    breath: 0.01,
    jitter: 0,
    vibrato: {rate: 6, depth: 0, onset: 1},
    source: 'pulse',
    pulseWidth: 0.22,
    articulation: {consonant: 1.15, attack: 0.003, release: 0.02},
    drive: 2.6,
    gain: 0.42,
    reverb: 0,
    contours: {decline: [0.4, -0.6], comma: 0.4, question: 3, exclaim: 0.8, statement: -1.2, ellipsis: -2, accent: 0.8, cjkAccent: 0.4},
  },
  // 尖细、语速快，卡通里的高音角色
  squeak: {
    register: 84,
    tempo: 8.4,
    formantScale: 1.32,
    tilt: 0.35,
    breath: 0.04,
    jitter: 0.14,
    vibrato: {rate: 6.4, depth: 0.012, onset: 0.06},
    source: 'saw',
    pulseWidth: 0.3,
    articulation: {consonant: 1.1, attack: 0.005, release: 0.022},
    drive: 1.9,
    gain: 0.45,
    reverb: 0,
    contours: {decline: [1.2, -1.8], comma: 1.5, question: 6, exclaim: 2, statement: -3, ellipsis: -5, accent: 1.8, cjkAccent: 1.3},
  },
};

const VOICE_KEYS = Object.freeze(Object.keys(VOICES));

/** 预设声线是只读数据，避免被调用方顺手改掉。 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
deepFreeze(VOICES);

function deepMerge(base, over) {
  const out = {...base};
  for (const [k, v] of Object.entries(over ?? {})) {
    const both = v && typeof v === 'object' && !Array.isArray(v)
      && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]);
    out[k] = both ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** 校验声线参数，给出能看懂的报错，而不是在 DSP 里悄悄变成 NaN。 */
function validateVoice(v, label = 'voice') {
  const need = (key, lo, hi) => {
    if (!isNum(v[key]) || v[key] < lo || v[key] > hi) {
      throw new TypeError(`${label}.${key} 必须是 ${lo}..${hi} 之间的数字，收到 ${String(v[key])}`);
    }
  };
  need('register', 12, 120);
  need('tempo', 1, 30);
  need('formantScale', 0.5, 2);
  need('tilt', 0, 1);
  need('breath', 0, 0.5);
  need('jitter', 0, 2);
  need('drive', 0.1, 10);
  need('gain', 0.01, 4);
  need('pulseWidth', 0.05, 0.95);
  if (v.source !== 'saw' && v.source !== 'pulse') throw new TypeError(`${label}.source 只能是 'saw' 或 'pulse'`);
  for (const k of ['rate', 'depth', 'onset']) {
    if (!isNum(v.vibrato?.[k]) || v.vibrato[k] < 0) throw new TypeError(`${label}.vibrato.${k} 必须是非负数`);
  }
  if (v.vibrato.depth > 0.3) throw new TypeError(`${label}.vibrato.depth 太大（上限 0.3）`);
  for (const k of ['attack', 'release']) {
    if (!isNum(v.articulation?.[k]) || v.articulation[k] <= 0) throw new TypeError(`${label}.articulation.${k} 必须是正数`);
  }
  if (!isNum(v.articulation.consonant) || v.articulation.consonant < 0) throw new TypeError(`${label}.articulation.consonant 必须是非负数`);
  const c = v.contours;
  if (!c || !Array.isArray(c.decline) || c.decline.length !== 2 || !c.decline.every(isNum)) {
    throw new TypeError(`${label}.contours.decline 必须是两个数字`);
  }
  for (const k of ['comma', 'question', 'exclaim', 'statement', 'ellipsis', 'accent', 'cjkAccent']) {
    if (!isNum(c[k])) throw new TypeError(`${label}.contours.${k} 必须是数字`);
  }
  return v;
}

/**
 * 生成一个新声线：在基础声线上做深度合并（嵌套对象不会整块覆盖）。
 * @param {object} overrides 覆盖项，例如 {register: 60, vibrato: {depth: 0.02}}
 * @param {string|object} [base] 基础声线名或对象，默认 'bibi'
 */
export function defineVoice(overrides, base = 'bibi') {
  const seed = typeof base === 'string' ? VOICES[base] : base;
  if (!seed) throw new TypeError(`未知声线 "${base}"，可选：${VOICE_KEYS.join(', ')}`);
  const voice = deepMerge(seed, overrides ?? {});
  return validateVoice(voice);
}

/** 把 voice 选项解析成一份完整声线（名字 / 对象 / 空）。 */
function resolveVoice(voice) {
  if (voice == null) return VOICES.bibi;
  if (typeof voice === 'string') {
    const v = VOICES[voice];
    if (!v) throw new TypeError(`未知声线 "${voice}"，可选：${VOICE_KEYS.join(', ')}`);
    return v;
  }
  if (typeof voice === 'object') return validateVoice(deepMerge(VOICES.bibi, voice));
  throw new TypeError('voice 需要是声线名、声线对象或省略');
}

/** 元音 → 口型开合度，给动画对口型用。 */
export function mouthOf(vowel) {
  const f = VOWELS[vowel] ?? VOWELS.a;
  return {open: clamp((f[0] - 250) / 550, 0, 1), wide: clamp((f[1] - 800) / 1500, 0, 1)};
}

// ─────────────────────────── 3. 文本规范化与切分 ───────────────────────────

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const TERMINALS = '.!?…';

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

/** 全角转半角、标点归并、保护词内连字符、去掉纯装饰符号；noteMarks 打开时保留 [C4]。 */
function normalize(text, noteMarks = false) {
  let s = String(text ?? '').normalize('NFC');
  s = s.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 音名标记 [C4] 先藏成占位符，不然下面那句会把方括号连同音名一起当装饰符号清掉。
  // 占位符里只有 \u0002 / \u0003 和数字，所有清理规则都碰不到它。
  const held = [];
  if (noteMarks) s = s.replace(/\[[^\]\n]{1,12}\]/g, (m) => `\u0002${held.push(m) - 1}\u0003`);
  s = s.replace(/\u3000/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '');
  s = s.replace(/[。、]/g, (c) => (c === '。' ? '.' : ','));
  s = s.replace(/[“”]/g, '');
  s = s.replace(/([A-Za-z])[‘’](?=[A-Za-z])/g, "$1'").replace(/[‘’]/g, '');
  s = s.replace(/[「」『』【】《》]/g, '');
  s = s.replace(/[()\[\]{}]/g, ' ');
  s = s.replace(/[—–]/g, '-');
  s = s.replace(/…+/g, '…').replace(/\.{3,}/g, '…');
  // 词内连字符先藏起来，剩下的破折号当逗号用
  s = s.replace(/([A-Za-z])[-\u2010-\u2015]+(?=[A-Za-z])/g, '$1\u0001');
  s = s.replace(/-+/g, ', ');
  s = s.replace(/\u0001/g, '-');
  // 千分位：30,000 → 30000
  s = s.replace(/(\d),(?=\d{3}(?:\D|$))/g, '$1');
  s = s.replace(/[^\S\n]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n');
  // 还原成 [C4]，让 tokenize 认出它、也让 plan.text 保持可读可回填
  if (held.length) s = s.replace(/\u0002(\d+)\u0003/g, (_, i) => held[Number(i)]);
  return s.trim();
}

/** 按句末标点切句，再按逗号分小句。小数点和词内连字符不会误切。 */
function segment(text) {
  const sentences = [];
  let start = 0;
  let i = 0;

  const flush = (end, mark) => {
    const body = text.slice(start, end).trim();
    if (!body) return;
    const clauses = splitClauses(body);
    if (!clauses.length) return;
    sentences.push({kind: classify(mark), end: mark, clauses});
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      flush(i, '');
      start = i + 1;
      i += 1;
      continue;
    }
    if (!TERMINALS.includes(ch)) {
      i += 1;
      continue;
    }
    if (ch === '.' && isDigit(text[i - 1]) && isDigit(text[i + 1])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < text.length && TERMINALS.includes(text[j + 1])) j += 1;
    flush(i, text.slice(i, j + 1));
    start = j + 1;
    i = j + 1;
  }
  flush(text.length, '');
  return sentences;
}

function splitClauses(body) {
  const out = [];
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (!',;:'.includes(ch)) continue;
    const text = body.slice(start, i).trim();
    if (text) out.push({text, mark: ch});
    else if (out.length) out[out.length - 1].mark = ch;
    start = i + 1;
  }
  const tail = body.slice(start).trim();
  if (tail) out.push({text: tail, mark: ''});
  return out;
}

function classify(mark) {
  if (mark.includes('?')) return 'question';
  if (mark.includes('!')) return 'exclaim';
  if (mark.includes('…')) return 'ellipsis';
  return 'statement';
}

function pauseFor(mark) {
  if (mark.includes('…')) return 0.55;
  if (mark.includes('.') || mark.includes('?') || mark.includes('!')) return 0.38;
  if (mark.includes(';') || mark.includes(':')) return 0.26;
  if (mark.includes(',')) return 0.2;
  return 0.3;
}

const KANA_RE = /[\u3041-\u309F\u30A1-\u30FF]/;

function detectLanguage(src) {
  let cjk = 0;
  let kana = 0;
  let latin = 0;
  for (const c of src) {
    if (KANA_RE.test(c)) kana += 1;
    else if (CJK_RE.test(c)) cjk += 1;
    else if (/[A-Za-z]/.test(c)) latin += 1;
  }
  // 出现假名就是日语：汉字别的语言也用，假名只有日语用
  if (kana) return 'ja';
  if (!cjk) return 'en';
  if (!latin) return 'zh';
  return cjk >= latin / 3 ? 'zh' : 'en';
}

// ─────────────────────────── 4. 分词与读音展开 ───────────────────────────

const TOKEN_RE = /(\[[^\]\n]{1,12}\])|([A-Za-z]+(?:['\-][A-Za-z]+)*)|(\d+(?:\.\d+)?)|([\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])|([\u3041-\u309F\u30A1-\u30FF]+)|([\s\S])/gu;

/** 汉字 / 假名串 / 拉丁词 / 数字 / 音名标记 / 其他（韩文、西里尔、表情符号……）。 */
function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m[1] !== undefined) out.push({type: 'note', text: m[1]});
    else if (m[2] !== undefined) out.push({type: 'word', text: m[2]});
    else if (m[3] !== undefined) out.push({type: 'number', text: m[3]});
    else if (m[4] !== undefined) out.push({type: 'cjk', text: m[4]});
    else if (m[5] !== undefined) out.push({type: 'kana', text: m[5]});
    else if (m[6] !== undefined && !/\s/u.test(m[6])) out.push({type: 'other', text: m[6]});
  }
  return out;
}

/** ASCII 标点不发声；表情符号、假名、韩文、西里尔等非 ASCII 字符各算一声。 */
function speakable(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0xa0) return false;
  if (cp >= 0x2000 && cp <= 0x206f) return false;
  if (cp >= 0xfe10 && cp <= 0xfe1f) return false;
  return true;
}

// —— 数字读法 ——

const CN_DIGITS = '零一二三四五六七八九';
const CN_UNITS = ['', '十', '百', '千'];
const CN_BIG = ['', '万', '亿', '万亿'];

function zhGroup(n) {
  let out = '';
  let zero = false;
  for (let i = 3; i >= 0; i -= 1) {
    const d = Math.floor(n / 10 ** i) % 10;
    if (!d) {
      if (out) zero = true;
      continue;
    }
    if (zero) {
      out += '零';
      zero = false;
    }
    out += CN_DIGITS[d] + CN_UNITS[i];
  }
  return out;
}

function spellZhInt(n) {
  if (n === 0) return '零';
  const groups = [];
  let x = n;
  while (x > 0) {
    groups.push(x % 10000);
    x = Math.floor(x / 10000);
  }
  let out = '';
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const g = groups[i];
    if (!g) continue;
    if (out && g < 1000) out += '零';
    out += zhGroup(g) + CN_BIG[i];
  }
  return out.replace(/^一十/, '十');
}

const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const EN_SCALE = ['', 'thousand', 'million', 'billion', 'trillion'];

function enGroup(n) {
  const out = [];
  if (n >= 100) {
    out.push(`${EN_ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) {
    const tens = EN_TENS[Math.floor(n / 10)];
    const ones = n % 10;
    out.push(ones ? `${tens} ${EN_ONES[ones]}` : tens);
  } else if (n > 0) {
    out.push(EN_ONES[n]);
  }
  return out.join(' ');
}

function spellEnInt(n) {
  if (n === 0) return 'zero';
  const parts = [];
  let i = 0;
  let x = n;
  while (x > 0) {
    const g = x % 1000;
    if (g) parts.unshift(enGroup(g) + (EN_SCALE[i] ? ` ${EN_SCALE[i]}` : ''));
    x = Math.floor(x / 1000);
    i += 1;
  }
  return parts.join(' ');
}

// —— 日语数字：读成假名，直接交给上面的假名前端 ——
const JA_DIGITS = ['れい', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう'];
const JA_BIG = ['', 'まん', 'おく', 'ちょう'];

/** 十/百/千 的位，带日语里那几个固定音变。 */
function jaUnit(d, place) {
  const digit = JA_DIGITS[d];
  if (place === 1) return d === 1 ? 'じゅう' : `${digit}じゅう`;
  if (place === 2) {
    if (d === 1) return 'ひゃく';
    if (d === 3) return 'さんびゃく';
    if (d === 6) return 'ろっぴゃく';
    if (d === 8) return 'はっぴゃく';
    return `${digit}ひゃく`;
  }
  if (d === 1) return 'せん';
  if (d === 3) return 'さんぜん';
  if (d === 8) return 'はっせん';
  return `${digit}せん`;
}

/** 日语不念零：1005 是 せんご，不是 せんれいご。 */
function spellJaInt(n) {
  if (n === 0) return 'ぜろ';
  const groups = [];
  let x = n;
  while (x > 0) {
    groups.push(x % 10000);
    x = Math.floor(x / 10000);
  }
  let out = '';
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const g = groups[i];
    if (!g) continue;
    let part = '';
    for (let place = 3; place >= 1; place -= 1) {
      const d = Math.floor(g / 10 ** place) % 10;
      if (d) part += jaUnit(d, place);
    }
    if (g % 10) part += JA_DIGITS[g % 10];
    out += part + JA_BIG[i];
  }
  return out;
}

/** 数字 → 文字的字符串（中文按万/亿分组，日语同理，英文按 thousand/million）。 */
function spellNumber(raw, language) {
  const text = String(raw);
  const digits = text.replace('.', '');
  if (digits.length > 12) {
    // 太长的号码逐位念
    const names = language === 'zh' ? CN_DIGITS : language === 'ja' ? JA_DIGITS : EN_ONES;
    return [...digits].map((d) => names[+d]).join(language === 'en' ? ' ' : '');
  }
  const [intPart, fracPart] = text.split('.');
  if (language === 'zh') {
    let out = spellZhInt(Number(intPart));
    if (fracPart) out += `点${[...fracPart].map((d) => CN_DIGITS[+d]).join('')}`;
    return out;
  }
  if (language === 'ja') {
    let out = spellJaInt(Number(intPart));
    if (fracPart) out += `てん${[...fracPart].map((d) => JA_DIGITS[+d]).join('')}`;
    return out;
  }
  let out = spellEnInt(Number(intPart));
  if (fracPart) out += ` point ${[...fracPart].map((d) => EN_ONES[+d]).join(' ')}`;
  return out;
}

// —— 拉丁词切音节 ——

const LATIN_ONSETS = {
  b: 'stop', c: 'stop', d: 'stop', f: 'fric', g: 'stop', h: 'fric', j: 'fric', k: 'stop',
  l: 'liquid', m: 'nasal', n: 'nasal', p: 'stop', q: 'stop', r: 'liquid', s: 'fric',
  t: 'stop', v: 'fric', w: 'liquid', x: 'fric', z: 'fric', y: 'liquid',
};

const LETTER_NAMES = {
  a: {vowels: ['e', 'i']},
  b: {vowels: ['i'], onset: 'stop'},
  c: {vowels: ['i'], onset: 'fric'},
  d: {vowels: ['i'], onset: 'stop'},
  e: {vowels: ['i']},
  f: {vowels: ['ɛ'], onset: 'fric'},
  g: {vowels: ['i'], onset: 'stop'},
  h: {vowels: ['e', 'i'], onset: 'fric'},
  i: {vowels: ['a', 'i']},
  j: {vowels: ['e', 'i'], onset: 'fric'},
  k: {vowels: ['e', 'i'], onset: 'stop'},
  l: {vowels: ['ɛ'], onset: 'liquid'},
  m: {vowels: ['ɛ'], onset: 'nasal'},
  n: {vowels: ['ɛ'], onset: 'nasal'},
  o: {vowels: ['o', 'u']},
  p: {vowels: ['i'], onset: 'stop'},
  q: {vowels: ['u', 'i'], onset: 'stop'},
  r: {vowels: ['a'], onset: 'liquid'},
  s: {vowels: ['ɛ'], onset: 'fric'},
  t: {vowels: ['i'], onset: 'stop'},
  u: {vowels: ['u']},
  v: {vowels: ['i'], onset: 'fric'},
  w: {vowels: ['u'], onset: 'liquid'},
  x: {vowels: ['ɛ'], onset: 'fric'},
  y: {vowels: ['a', 'i'], onset: 'liquid'},
  z: {vowels: ['i'], onset: 'fric'},
};

function gestureOf(type) {
  switch (type) {
    case 'stop':
      return {type, freq: 2600, q: 2.2, closure: 0.012, burst: 0.55, lead: 0.03};
    case 'fric':
      return {type, freq: 4200, q: 2.4, burst: 0.45, lead: 0.045};
    case 'nasal':
      return {type, lead: 0.032};
    case 'liquid':
      return {type, lead: 0.036};
    default:
      return {type: 'none', lead: 0};
  }
}

const isVowelLetter = (c) => 'aeiouy'.includes(c);

function vowelNames(group) {
  const map = {a: 'a', e: 'e', i: 'i', o: 'o', u: 'u', y: 'i'};
  const first = map[group[0]] ?? 'ə';
  const out = [first];
  const second = map[group[1]];
  if (second && second !== first) out.push(second);
  return out;
}

function codaOf(codaLetters) {
  if (codaLetters.endsWith('ng')) return 'ng';
  if (codaLetters.endsWith('n') || codaLetters.endsWith('m')) return 'n';
  return null;
}

function onsetTypeOf(letters) {
  if (!letters) return 'none';
  if (/^(sh|ch|th|ph|wh)/.test(letters)) return 'fric';
  return LATIN_ONSETS[letters[0]] ?? 'none';
}

/** 元音组数量法切音节；词尾不发音的 e、辅音 + le 单独处理。 */
function syllabifyWord(word) {
  const letters = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!letters) return [{chunk: word, vowels: ['ə'], onset: 'none', coda: null, stress: 1}];

  if (letters.length > 3 && /[^aeiouy]le$/.test(letters)) {
    const head = syllabifyWord(letters.slice(0, -2));
    head.push({chunk: 'le', vowels: ['ə'], onset: 'liquid', coda: null, stress: 0});
    return head;
  }

  const groups = [];
  for (let i = 0; i < letters.length; i += 1) {
    if (!isVowelLetter(letters[i])) continue;
    if (letters[i] === 'y' && i === 0) continue;
    const g = groups[groups.length - 1];
    if (g && g.end === i) g.end = i + 1;
    else groups.push({start: i, end: i + 1});
  }
  if (!groups.length) groups.push({start: 0, end: 1});

  const last = groups[groups.length - 1];
  if (groups.length > 1 && last.end === letters.length && letters.endsWith('e')
    && !isVowelLetter(letters[letters.length - 2])) {
    groups.pop();
  }

  // audio / radio：结尾的 io 分成两个音节
  const tail = groups[groups.length - 1];
  if (tail && letters.slice(tail.start, tail.end) === 'io') {
    groups.splice(groups.length - 1, 1,
      {start: tail.start, end: tail.start + 1},
      {start: tail.start + 1, end: tail.end});
  }

  const out = [];
  for (let k = 0; k < groups.length; k += 1) {
    const g = groups[k];
    // 最大音节首原则：辅音丛里第一个归前一个音节，其余归后一个音节
    const start = k === 0 ? 0 : (() => {
      const prev = groups[k - 1];
      const cluster = g.start - prev.end;
      return prev.end + (cluster > 1 ? 1 : 0);
    })();
    const end = k === groups.length - 1 ? letters.length : (() => {
      const next = groups[k + 1];
      const cluster = next.start - g.end;
      return g.end + (cluster > 1 ? 1 : 0);
    })();
    out.push({
      chunk: letters.slice(start, end),
      vowels: vowelNames(letters.slice(g.start, g.end)),
      onset: onsetTypeOf(letters.slice(start, g.start)),
      coda: codaOf(letters.slice(g.end, end)),
      stress: k === 0 ? 1 : 0,
    });
  }
  return out;
}

// ─────────────────────────── 5. 拼音与假名前端 ───────────────────────────

const PINYIN_INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
  'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];
const APICAL_INITIALS = new Set(['zh', 'ch', 'sh', 'r', 'z', 'c', 's']);

const ZERO_INITIAL = {
  yi: 'i', ya: 'ia', ye: 'ie', yao: 'iao', you: 'iou', yan: 'ian', yin: 'in',
  yang: 'iang', ying: 'ing', yong: 'iong', yu: 'ü', yue: 'üe', yuan: 'üan', yun: 'ün',
  wu: 'u', wa: 'ua', wo: 'uo', wai: 'uai', wei: 'uei', wan: 'uan', wen: 'uen',
  wang: 'uang', weng: 'ueng',
};

const PINYIN_FINALS = {
  a: {v: ['a']},
  o: {v: ['o']},
  e: {v: ['ə']},
  ê: {v: ['ɛ']},
  i: {v: ['i']},
  u: {v: ['u']},
  ü: {v: ['y']},
  er: {v: ['ə']},
  ai: {v: ['a', 'i']},
  ei: {v: ['e', 'i']},
  ao: {v: ['a', 'u']},
  ou: {v: ['o', 'u']},
  an: {v: ['a'], coda: 'n'},
  en: {v: ['ə'], coda: 'n'},
  ang: {v: ['a'], coda: 'ng'},
  eng: {v: ['ə'], coda: 'ng'},
  ong: {v: ['o'], coda: 'ng'},
  ia: {v: ['i', 'a']},
  ie: {v: ['i', 'ɛ']},
  iao: {v: ['i', 'a', 'u']},
  iou: {v: ['i', 'o', 'u']},
  ian: {v: ['i', 'ɛ', 'a'], coda: 'n'},
  in: {v: ['i'], coda: 'n'},
  iang: {v: ['i', 'a'], coda: 'ng'},
  ing: {v: ['i'], coda: 'ng'},
  iong: {v: ['i', 'o'], coda: 'ng'},
  ua: {v: ['u', 'a']},
  uo: {v: ['u', 'o']},
  uai: {v: ['u', 'a', 'i']},
  uei: {v: ['u', 'e', 'i']},
  uan: {v: ['u', 'a'], coda: 'n'},
  uen: {v: ['u', 'ə'], coda: 'n'},
  uang: {v: ['u', 'a'], coda: 'ng'},
  ueng: {v: ['u', 'ə'], coda: 'ng'},
  üe: {v: ['y', 'ɛ']},
  üan: {v: ['y', 'ɛ'], coda: 'n'},
  ün: {v: ['y'], coda: 'n'},
  apical: {v: ['apical']},
};

/** 辅音手势表。拼音按声母查，假名按行查，两边口型都够用。 */
const ONSETS = {
  '': {type: 'none', lead: 0},
  b: {type: 'stop', freq: 1200, q: 2, closure: 0.012, burst: 0.35, lead: 0.03},
  p: {type: 'stop', freq: 1400, q: 2, closure: 0.014, burst: 0.7, lead: 0.034},
  m: {type: 'nasal', lead: 0.034},
  f: {type: 'fric', freq: 1600, q: 1.6, burst: 0.35, lead: 0.045},
  d: {type: 'stop', freq: 3000, q: 2.4, closure: 0.01, burst: 0.4, lead: 0.028},
  t: {type: 'stop', freq: 3400, q: 2.4, closure: 0.014, burst: 0.7, lead: 0.032},
  n: {type: 'nasal', lead: 0.032},
  l: {type: 'liquid', lead: 0.036},
  g: {type: 'stop', freq: 1800, q: 2, closure: 0.012, burst: 0.45, lead: 0.03},
  k: {type: 'stop', freq: 2000, q: 2, closure: 0.016, burst: 0.75, lead: 0.034},
  h: {type: 'fric', freq: 1200, q: 1.2, burst: 0.35, lead: 0.05},
  j: {type: 'fric', freq: 3400, q: 2.6, burst: 0.45, lead: 0.05},
  q: {type: 'fric', freq: 3800, q: 2.6, burst: 0.5, lead: 0.052},
  x: {type: 'fric', freq: 4400, q: 2.6, burst: 0.42, lead: 0.05},
  zh: {type: 'stop', freq: 3200, q: 2.4, closure: 0.008, burst: 0.45, lead: 0.04},
  ch: {type: 'stop', freq: 3400, q: 2.4, closure: 0.01, burst: 0.65, lead: 0.044},
  sh: {type: 'fric', freq: 3000, q: 2.4, burst: 0.45, lead: 0.052},
  r: {type: 'liquid', lead: 0.04},
  z: {type: 'stop', freq: 5200, q: 2.6, closure: 0.008, burst: 0.4, lead: 0.036},
  c: {type: 'stop', freq: 5600, q: 2.6, closure: 0.01, burst: 0.65, lead: 0.04},
  s: {type: 'fric', freq: 5800, q: 2.8, burst: 0.4, lead: 0.055},
  y: {type: 'liquid', lead: 0.03},
  w: {type: 'liquid', lead: 0.03},
};

const TONE_MARK_RE = /[\u0101\u00e1\u01ce\u00e0\u0113\u00e9\u011b\u00e8\u012b\u00ed\u01d0\u00ec\u014d\u00f3\u01d2\u00f2\u016b\u00fa\u01d4\u00f9\u01d6\u01d8\u01da\u01dc]/;

/** 调号或尾部数字 → 声调；返回去掉声调符号的拼音。 */
function readTone(raw) {
  let base = '';
  let tone = null;
  for (const ch of raw.normalize('NFD')) {
    if (ch === '\u0304') { tone = 1; continue; }
    if (ch === '\u0301') { tone = 2; continue; }
    if (ch === '\u030c') { tone = 3; continue; }
    if (ch === '\u0300') { tone = 4; continue; }
    if (ch === '\u0308') { base = `${base.slice(0, -1)}ü`; continue; }
    base += ch;
  }
  const m = /^(.*)([0-5])$/.exec(base);
  if (m) {
    base = m[1];
    tone = Number(m[2]);
  }
  if (tone === 5 || tone === null) tone = 0;
  return {base: base.toLowerCase(), tone};
}

function parsePinyin(raw) {
  const {base, tone} = readTone(raw);
  let s = base.replace(/v/g, 'ü');
  if (!/^[a-zü]+$/.test(s)) return null;
  let initial = '';
  let final = s;
  for (const ini of PINYIN_INITIALS) {
    if (s.startsWith(ini) && s.length > ini.length) {
      initial = ini;
      final = s.slice(ini.length);
      break;
    }
  }
  if (initial === 'y' || initial === 'w') {
    const expanded = ZERO_INITIAL[initial + final];
    if (!expanded) return null;
    initial = '';
    final = expanded;
  }
  if ('jqx'.includes(initial) && initial && final.startsWith('u')) final = `ü${final.slice(1)}`;
  if (initial) {
    if (final === 'iu') final = 'iou';
    else if (final === 'ui') final = 'uei';
    else if (final === 'un') final = 'uen';
  }
  if (APICAL_INITIALS.has(initial) && final === 'i') final = 'apical';
  const entry = PINYIN_FINALS[final];
  if (!entry) return null;
  return {initial, final, tone, entry};
}

function pinyinSyllable(raw) {
  const p = parsePinyin(raw);
  if (!p) return null;
  const g = ONSETS[p.initial] ?? ONSETS[''];
  return {
    text: raw,
    vowels: p.entry.v.slice(),
    onset: {...g},
    coda: p.entry.coda ?? null,
    tone: p.tone,
    toneScale: 1,
    stress: 0,
    jitter: unit(hash(raw), 0x9e37),
    kind: 'pinyin',
  };
}

function looksLikePinyin(src) {
  // 音名标记不参与判定，否则 ni3[C4] hao3[D4] 永远识别不出来
  const tokens = src.replace(/\[[^\]\n]{1,12}\]/g, ' ').replace(/[,;:.!?…]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 200) return false;
  let toned = false;
  for (const tok of tokens) {
    const bare = tok.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (!/^[a-z]+[0-5]?$/.test(bare)) return false;
    if (/[0-5]$/.test(bare) || TONE_MARK_RE.test(tok)) toned = true;
  }
  return toned;
}

// —— 假名 → モーラ ——
// 五十音直接查表：元音按段取，声母复用上面那张手势表。
// 促音「っ」是一拍静音，长音「ー」把前一拍再拖一拍，拨音「ん」是整拍鼻音。

const KANA_VOWELS = ['a', 'i', 'u', 'e', 'o'];

/** 行 → 五个假名，空格用 null 占位。 */
const KANA_ROWS = {
  '': ['あ', 'い', 'う', 'え', 'お'],
  k: ['か', 'き', 'く', 'け', 'こ'],
  g: ['が', 'ぎ', 'ぐ', 'げ', 'ご'],
  s: ['さ', 'し', 'す', 'せ', 'そ'],
  z: ['ざ', 'じ', 'ず', 'ぜ', 'ぞ'],
  t: ['た', 'ち', 'つ', 'て', 'と'],
  d: ['だ', 'ぢ', 'づ', 'で', 'ど'],
  n: ['な', 'に', 'ぬ', 'ね', 'の'],
  h: ['は', 'ひ', 'ふ', 'へ', 'ほ'],
  b: ['ば', 'び', 'ぶ', 'べ', 'ぼ'],
  p: ['ぱ', 'ぴ', 'ぷ', 'ぺ', 'ぽ'],
  m: ['ま', 'み', 'む', 'め', 'も'],
  y: ['や', null, 'ゆ', null, 'よ'],
  r: ['ら', 'り', 'る', 'れ', 'ろ'],
  w: ['わ', null, null, null, 'を'],
  v: ['ゔ', null, null, null, null],
};

/** 行不规整的假名：し / ち / つ / ふ / じ / ぢ / づ 借拼音现成的声母。 */
const KANA_ONSET_ALIAS = {し: 'sh', ち: 'ch', つ: 'c', ふ: 'f', じ: 'j', ぢ: 'j', づ: 'z'};

const KANA_TABLE = new Map();
for (const [onset, row] of Object.entries(KANA_ROWS)) {
  row.forEach((ch, i) => {
    if (ch) KANA_TABLE.set(ch, {onset: KANA_ONSET_ALIAS[ch] ?? onset, vowel: KANA_VOWELS[i]});
  });
}

// を 只做宾格助词，永远念 o，别念成 wo
KANA_TABLE.set('を', {onset: '', vowel: 'o'});

/** 拗音和外来音的第二拍：只换元音，仍然算一拍。 */
const SMALL_VOWELS = {ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'a', ゅ: 'u', ょ: 'o', ゎ: 'a'};
const YOON = new Set(['ゃ', 'ゅ', 'ょ']);

/** 片假名 → 平假名，和五十音共用同一张表。 */
function toHiragana(ch) {
  const cp = ch.codePointAt(0);
  return cp >= 0x30a1 && cp <= 0x30f6 ? String.fromCodePoint(cp - 0x60) : ch;
}

function kanaSyllable(text, part) {
  const g = ONSETS[part.onset] ?? ONSETS[''];
  const syllable = {
    text,
    vowels: [part.vowel],
    onset: {...g},
    coda: null,
    tone: null,
    toneScale: 1,
    stress: 0,
    jitter: unit(hash(text), 0x9e37),
    kind: 'kana',
    moras: 1,
  };
  if (part.nasalOnly) syllable.nasalOnly = true;
  return syllable;
}

/** 假名串 → モーラ列表。・ ゛ 之类认不出来的假名当标点跳过。 */
function kanaSyllables(text) {
  const out = [];
  let prev = null;
  for (let i = 0; i < text.length; i += 1) {
    const raw = text[i];
    if (raw === 'っ' || raw === 'ッ') {
      // 促音占一拍，但自己不发声；后面那个辅音负责把这一拍填满
      out.push({text: raw, kind: 'kana', pause: true, moras: 1});
      prev = null;
      continue;
    }
    if (raw === 'ー') {
      // 长音把前一拍再拖一拍，声调曲线跟着一起拉长
      if (prev) prev.moras += 1;
      continue;
    }
    const ch = toHiragana(raw);
    if (ch === 'ん') {
      prev = kanaSyllable(raw, {onset: 'n', vowel: 'ə', nasalOnly: true});
      out.push(prev);
      continue;
    }
    const base = KANA_TABLE.get(ch);
    if (!base) continue;
    const next = text[i + 1] ? toHiragana(text[i + 1]) : '';
    const small = SMALL_VOWELS[next];
    // きゃ / しぇ / ふぁ / てぃ：辅音不变、只换元音，占一拍
    if (small && (YOON.has(next) || base.onset !== '')) {
      prev = kanaSyllable(raw + text[i + 1], {onset: base.onset, vowel: small});
      out.push(prev);
      i += 1;
      continue;
    }
    prev = kanaSyllable(raw, {onset: base.onset, vowel: base.vowel});
    out.push(prev);
  }
  return out;
}

// —— 音名标记 ——
// 写成 あ[C4] 就是「这个字唱 C4」。C4 = MIDI 60，规划期按 register 换算成相对半音，
// 所以 render 一行都不用改；标记紧跟在前一个有声字符后面，连写多个就是音节内的滑音：
// あ[C4][E4] 从 C4 滑到 E4。

const NOTE_RE = /^([a-g])([#♯b♭]?)(-?\d{1,2})$/;
const NOTE_STEP = {c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11};
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** "C4" / "F#3" / "Bb5" → MIDI 音高；认不出来返回 null。 */
function parseNote(raw) {
  const m = NOTE_RE.exec(String(raw).trim().toLowerCase());
  if (!m) return null;
  const accidental = m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0;
  const midi = (Number(m[3]) + 1) * 12 + NOTE_STEP[m[1]] + accidental;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/** MIDI 音高 → "C4"，给 cues 和演示页显示用。 */
function noteName(midi) {
  const n = Math.round(Number(midi));
  if (!isNum(n) || n < 0 || n > 127) return null;
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
}

/** 只由音名标记组成的串（" [C4][E4]" → 两个音高，认不出来的忽略并记 warning）。 */
function notesOf(raw, sf) {
  const out = [];
  for (const m of String(raw).matchAll(/\[([^\]\n]{1,12})\]/g)) {
    const midi = parseNote(m[1]);
    if (midi === null) sf.warnings.push(`音名无法解析「[${m[1]}]」`);
    else out.push(midi);
  }
  return out;
}

// ─────────────────────────── 6. 音节与韵律 ───────────────────────────

/** 汉字/表情符号等：哈希决定元音、辅音、声调、抖动四个互相独立的维度。 */
function hashSyllable(text, kind) {
  const seed = hash(text);
  const pool = ['a', 'a', 'o', 'e', 'e', 'i', 'u', 'ə', 'æ'];
  const roll = pick(seed, 0x2f1b, 20);
  const type = roll < 12 ? 'none' : roll < 15 ? 'liquid' : roll < 17 ? 'nasal' : roll < 19 ? 'fric' : 'stop';
  const tr = pick(seed, 0x7c3a, 11);
  const tone = tr < 3 ? 1 : tr < 6 ? 2 : tr < 8 ? 3 : tr < 10 ? 4 : 0;
  return {
    text,
    vowels: [pool[pick(seed, 0x51ed, pool.length)]],
    onset: gestureOf(type),
    coda: null,
    tone,
    toneScale: 0.85,
    stress: 0,
    jitter: unit(seed, 0x9e37),
    kind,
  };
}

function makeSyllable(text, spec, kind) {
  const seed = hash(text + '|' + spec.vowels.join(''));
  return {
    text,
    vowels: spec.vowels.slice(),
    onset: gestureOf(spec.onset),
    coda: spec.coda ?? null,
    tone: spec.tone ?? null,
    toneScale: spec.toneScale ?? 1,
    stress: spec.stress ? 1 : 0,
    jitter: unit(seed, 0x9e37),
    kind,
  };
}

function wordSyllables(word, sf) {
  const out = [];
  if (sf.readAcronyms && /^[A-Z]{2,5}$/.test(word)) {
    for (const letter of word) {
      const name = LETTER_NAMES[letter.toLowerCase()];
      if (name) out.push(makeSyllable(letter, {vowels: name.vowels, onset: name.onset ?? 'none'}, 'latin'));
    }
  } else {
    for (const s of syllabifyWord(word)) {
      out.push(makeSyllable(s.chunk, {vowels: s.vowels, onset: s.onset, coda: s.coda, stress: s.stress}, 'latin'));
    }
  }
  return out;
}

function textSyllables(text, sf) {
  const out = [];
  // 上一个出声的 token 产出的音节：音名标记钉在它的第一个音节上。
  // 促音（っ）和长音（ー）自己不产生音节，所以标记会落到前面最近的那个有声字符上。
  let last = null;
  for (const tok of tokenize(text)) {
    if (tok.type === 'note') {
      const notes = notesOf(tok.text, sf);
      if (!notes.length) continue;
      if (last) last[0].notes = [...(last[0].notes ?? []), ...notes];
      else sf.warnings.push(`音名标记「${tok.text}」前面没有可发声的字符`);
      continue;
    }
    let list = [];
    if (tok.type === 'number' && sf.readNumbers) {
      // 数字先读成词，再递归切音节；每个词自己编号。
      // 注意别改写成 list = ...：那会把整串数字并成一个 wordId，字间停顿会跟着变。
      const words = textSyllables(spellNumber(tok.text, sf.language), sf);
      if (words.length) last = words.filter((syl) => !syl.pause);
      out.push(...words);
      continue;
    }
    if (tok.type === 'word') list = wordSyllables(tok.text, sf);
    else if (tok.type === 'number') {
      for (const ch of tok.text) list.push(hashSyllable(ch, 'other'));
    } else if (tok.type === 'kana') list = kanaSyllables(tok.text);
    else if (tok.type === 'cjk') list = [hashSyllable(tok.text, 'cjk')];
    else if (speakable(tok.text)) list = [hashSyllable(tok.text, 'other')];
    if (!list.length) continue;
    const sounding = list.filter((syl) => !syl.pause);
    if (sounding.length) last = sounding;
    const wordId = sf.word++;
    for (const syl of list) {
      syl.wordId = wordId;
      out.push(syl);
    }
  }
  return out;
}

function pinyinClause(text, sf) {
  const out = [];
  for (const raw of text.trim().split(/\s+/)) {
    if (!raw) continue;
    // 音名标记可以贴在拼音词尾：ni3[C4]。先切下来，否则整词解析失败。
    const m = sf.noteMarks ? /^(.*?)((?:\[[^\]\n]{1,12}\])+)$/.exec(raw) : null;
    if (m && !m[1]) {
      // 整个词只有标记（例如标记前多打了个空格），没有音节可钉
      notesOf(m[2], sf);
      sf.warnings.push(`音名标记「${raw}」前面没有可发声的字符`);
      continue;
    }
    const tok = m ? m[1] : raw;
    const notes = m ? notesOf(m[2], sf) : [];
    const syl = pinyinSyllable(tok);
    if (syl) {
      if (notes.length) syl.notes = notes;
      syl.wordId = sf.word++;
      out.push(syl);
    } else {
      sf.warnings.push(`拼音无法解析「${tok}」，按普通文本处理`);
      // raw 里还带着音名，交给文本前端自己挂到音节上
      out.push(...textSyllables(raw, sf));
    }
  }
  return out;
}

function syllablesOf(text, sf) {
  return sf.mode === 'pinyin' ? pinyinClause(text, sf) : textSyllables(text, sf);
}

function terminalAt(kind, p, c) {
  switch (kind) {
    case 'question':
      return lerp(-1, c.question, p);
    case 'exclaim':
      return c.exclaim * (1 - 0.35 * p);
    case 'ellipsis':
      return lerp(-0.5, c.ellipsis, p);
    case 'comma':
      return c.comma * p;
    default:
      return c.statement * p;
  }
}

/** 把音节排上时间轴，算出绝对音高轮廓、停顿和口型 cues。 */
function buildPlan(sentences, src, sf, opts) {
  const tempo = clamp(opts.tempo ?? 7, 1, 30);
  const base = 1 / tempo;
  const pauseScale = clamp(opts.pauseScale ?? 1, 0.2, 3);
  const maxDuration = opts.maxDuration ?? 600;
  const c = {...DEFAULT_CONTOURS, ...(opts.contours ?? {})};
  // 音名是按这个 register 换算成相对半音的；speak() 会填成声线自己的 register
  const register = isNum(opts.register) ? opts.register : VOICES.bibi.register;
  const events = [];
  const cues = [];
  let notesUsed = false;
  let t = 0.06;
  let truncated = false;

  outer:
  for (let si = 0; si < sentences.length; si += 1) {
    const sentence = sentences[si];
    const total = sentence.clauses.reduce((n, cl) => n + cl.syllables.length, 0);
    if (!total) continue;
    let done = 0;
    for (let ci = 0; ci < sentence.clauses.length; ci += 1) {
      const clause = sentence.clauses[ci];
      const n = clause.syllables.length;
      const lastClause = ci === sentence.clauses.length - 1;
      if (!n) continue;
      // 促音占位项不发声，句尾/小句尾要落在最后一个真音节上
      const lastReal = clause.syllables.reduce((last, s, i) => (s.pause ? last : i), -1);
      for (let k = 0; k < n; k += 1) {
        const syl = clause.syllables[k];
        if (syl.pause) {
          // 促音：一整拍静音，后面那个辅音的闭口正好接上
          const hold = base * (syl.moras ?? 1);
          events.push({kind: 'pause', t0: t, t1: t + hold, reason: syl.text, after: 'mora'});
          t += hold;
          if (t > maxDuration) {
            truncated = true;
            break outer;
          }
          continue;
        }
        const clauseLast = k === lastReal;
        const sentenceLast = lastClause && clauseLast;
        const pos = (done + k + 0.5) / total;
        const accent = syl.stress ? c.accent
          : (k === n - 2 && n >= 2 && syl.kind === 'cjk' && clause.syllables[k].kind === 'cjk') ? c.cjkAccent : 0;
        const shape = syl.tone !== null && syl.tone !== undefined ? TONE_SHAPES[syl.tone] ?? [0, 0] : [0, 0];
        const termKind = sentenceLast ? sentence.kind : clauseLast ? 'comma' : null;
        const decl = lerp(c.decline[0], c.decline[1], pos);
        // 手动音高：写了音名就整段替换——声调轮廓、句尾起伏都不再叠加，
        // 用户写了 C4 就该听到 C4。没写音名的音节照旧算语调。
        const manual = syl.notes?.length ? syl.notes.map((midi) => midi - register) : null;
        if (manual) notesUsed = true;
        const pitch = manual ?? shape.map((v, i) => {
          const p = shape.length === 1 ? 0 : i / (shape.length - 1);
          return v * (syl.toneScale ?? 1) + decl + accent + (termKind ? terminalAt(termKind, p, c) : 0);
        });
        // 日语是等モーラ节奏：普通拍几乎一样长，只有小句/句尾稍微拖一点
        const factor = syl.kind === 'kana'
          ? (sentenceLast ? 1.4 : clauseLast ? 1.08 : 0.85)
          : (sentenceLast ? 1.55 : clauseLast ? 1.35 : syl.stress ? 0.92 : 0.78);
        const dur = Math.max(0.03, base * factor * (syl.tone === 3 ? 1.08 : 1) * (syl.moras ?? 1));
        events.push({
          kind: 'syl',
          t0: t,
          t1: t + dur,
          text: syl.text,
          wordId: syl.wordId,
          vowels: syl.vowels.slice(),
          onset: {...syl.onset},
          coda: syl.coda,
          pitch,
          amp: sentence.kind === 'exclaim' ? 1.22 : sentence.kind === 'ellipsis' ? 0.86 : 1,
          stress: syl.stress ? 1 : 0,
          tone: syl.tone,
          jitter: syl.jitter,
          kindOf: syl.kind,
          ...(manual ? {notes: syl.notes.slice()} : {}),
          ...(syl.kind === 'kana' ? {moras: syl.moras, nasalOnly: syl.nasalOnly} : {}),
          phraseId: si,
          terminal: sentenceLast,
          finalSyl: clauseLast,
        });
        cues.push({
          i: cues.length,
          text: syl.text,
          t0: t,
          t1: t + dur,
          pitch: pitch[0],
          ...(manual ? {note: noteName(syl.notes[0])} : {}),
          vowel: syl.vowels[0],
          onset: syl.onset.type,
          stress: syl.stress ? 1 : 0,
          tone: syl.tone,
          mouth: mouthOf(syl.vowels[0]),
        });
        t += dur;
        const next = clause.syllables[k + 1];
        if (next) {
          const cjkRun = syl.kind === 'cjk' && next.kind === 'cjk';
          t += base * (cjkRun || next.wordId === syl.wordId ? 0.15 : 0.22);
        }
        if (t > maxDuration) {
          truncated = true;
          break outer;
        }
      }
      const mark = lastClause ? sentence.end : clause.mark;
      const pause = pauseFor(mark) * pauseScale;
      if (pause > 0) {
        events.push({kind: 'pause', t0: t, t1: t + pause, reason: mark, after: lastClause ? 'terminal' : 'clause'});
        t += pause;
      }
      if (t > maxDuration) {
        truncated = true;
        break outer;
      }
      done += n;
    }
  }

  return {
    version: 1,
    text: src,
    mode: sf.mode,
    language: sf.language,
    tempo,
    ...(notesUsed ? {register} : {}),
    events,
    cues,
    duration: t,
    truncated,
    warnings: [...new Set(sf.warnings)],
  };
}

/**
 * 分析文本，得到一份与音色无关的「乐谱」。
 * @param {string} text
 * @param {object} [opts] tempo / mode / noteMarks / register / language / readNumbers /
 *   readAcronyms / pauseScale / maxDuration / contours
 */
export function analyze(text, opts = {}) {
  const noteMarks = opts.noteMarks ?? 'off';
  if (noteMarks !== 'off' && noteMarks !== 'auto') {
    throw new TypeError(`noteMarks 只能是 'off' 或 'auto'，收到 "${noteMarks}"`);
  }
  if (opts.register !== undefined && (!isNum(opts.register) || opts.register < 0 || opts.register > 127)) {
    throw new TypeError(`register 必须是 0..127 的 MIDI 音高，收到 ${opts.register}`);
  }
  const src = normalize(text, noteMarks === 'auto');
  const language = opts.language && opts.language !== 'auto' ? opts.language : detectLanguage(src);
  const mode = opts.mode && opts.mode !== 'auto' ? opts.mode : (looksLikePinyin(src) ? 'pinyin' : 'text');
  if (mode !== 'text' && mode !== 'pinyin') throw new TypeError(`mode 只能是 'text' 或 'pinyin'，收到 "${mode}"`);
  const sf = {
    mode,
    language,
    noteMarks: noteMarks === 'auto',
    readNumbers: opts.readNumbers !== false,
    readAcronyms: opts.readAcronyms !== false,
    warnings: [],
    word: 0,
  };

  const sentences = [];
  for (const s of segment(src)) {
    const clauses = s.clauses.map((cl) => ({mark: cl.mark, syllables: syllablesOf(cl.text, sf)}));
    // 只有促音占位、没有真音节的小句不出声
    if (clauses.some((cl) => cl.syllables.some((syl) => !syl.pause))) {
      sentences.push({kind: s.kind, end: s.end, clauses});
    }
  }

  if (!sentences.length) {
    return {
      version: 1,
      text: src,
      mode,
      language,
      tempo: clamp(opts.tempo ?? 7, 1, 30),
      events: [],
      cues: [],
      duration: 0,
      truncated: false,
      warnings: [...new Set(sf.warnings)],
    };
  }
  return buildPlan(sentences, src, sf, opts);
}

// ─────────────────────────── 7. DSP ───────────────────────────

/** 抗混叠锯齿：polyBLEP 两个跳变点各补一段二次曲线。 */
function sawAt(ph, dt) {
  let v = 2 * ph - 1;
  if (ph < dt) {
    const t = ph / dt;
    v -= t + t - t * t - 1;
  } else if (ph > 1 - dt) {
    const t = (ph - 1) / dt;
    v -= t * t + t + t + 1;
  }
  return v;
}

/** 声源：锯齿波，或用两条锯齿相减得到的脉冲波。相位在闭包里连续，滑音不炸。 */
function makeSource(kind, sr, width) {
  const w = clamp(width, 0.05, 0.95);
  let ph = 0;
  return (f) => {
    const dt = f / sr;
    ph += dt;
    if (ph >= 1) ph -= 1;
    if (kind !== 'pulse') return sawAt(ph, dt);
    const shifted = ph + 1 - w;
    return 0.5 * (sawAt(ph, dt) - sawAt(shifted >= 1 ? shifted - 1 : shifted, dt));
  };
}

function makeOnePole(sr, fc) {
  const k = 1 - Math.exp((-TAU * clamp(fc, 20, sr * 0.45)) / sr);
  let y = 0;
  return (x) => {
    y += (x - y) * k;
    return y;
  };
}

/** TPT 状态变量滤波器，取带通输出；任意采样率都稳。 */
function makeSvf(sr) {
  let ic1 = 0;
  let ic2 = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  return {
    set(fc, q) {
      const g = Math.tan((Math.PI * clamp(fc, 10, sr * 0.45)) / sr);
      const k = 1 / Math.max(0.1, q);
      a1 = 1 / (1 + g * (g + k));
      a2 = g * a1;
      a3 = g * a2;
    },
    bp(x) {
      const v3 = x - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      return v1;
    },
  };
}

function onsetLead(onset) {
  if (isNum(onset.lead)) return onset.lead;
  switch (onset.type) {
    case 'stop': return 0.03;
    case 'fric': return 0.05;
    case 'nasal': return 0.032;
    case 'liquid': return 0.036;
    default: return 0;
  }
}

/** 在音节内部按进度取出三个共振峰目标（写入 out）。 */
function vowelTargets(ev, p, table, out) {
  const list = Array.isArray(ev.vowels) && ev.vowels.length ? ev.vowels : ['a'];
  if (list.length === 1) {
    const f = table[list[0]] ?? table.a;
    out[0] = f[0];
    out[1] = f[1];
    out[2] = f[2];
    return;
  }
  const reach = list.length >= 3 ? 0.85 : 0.6;
  const q = clamp(p / reach, 0, 1) * (list.length - 1);
  const i0 = Math.min(list.length - 2, Math.floor(q));
  const w = q - i0;
  const A = table[list[i0]] ?? table.a;
  const B = table[list[i0 + 1]] ?? table.a;
  for (let k = 0; k < 3; k += 1) out[k] = lerp(A[k], B[k], w);
}

/** 三个锚点之间线性插值；锚点越少曲线越简单。 */
function sampleAnchors(anchors, p) {
  const a = Array.isArray(anchors) && anchors.length ? anchors : [0];
  if (a.length === 1) return a[0];
  const x = clamp(p, 0, 1) * (a.length - 1);
  const i = Math.min(a.length - 2, Math.floor(x));
  return lerp(a[i], a[i + 1], x - i);
}

function addReverb(buf, sr, mix) {
  const combs = [29.7, 37.1, 41.1, 43.7].map((ms) => ({
    buf: new Float32Array(Math.max(1, Math.round((ms / 1000) * sr))),
    i: 0,
    fb: 0.78,
  }));
  const aps = [5, 1.7].map((ms) => ({
    buf: new Float32Array(Math.max(1, Math.round((ms / 1000) * sr))),
    i: 0,
    g: 0.7,
  }));
  for (let n = 0; n < buf.length; n += 1) {
    const x = buf[n];
    let wet = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.buf[c.i] = x + y * c.fb;
      c.i = (c.i + 1) % c.buf.length;
      wet += y;
    }
    wet *= 0.25;
    for (const a of aps) {
      const y = a.buf[a.i];
      const v = -a.g * wet + y;
      a.buf[a.i] = wet + a.g * v;
      a.i = (a.i + 1) % a.buf.length;
      wet = v;
    }
    buf[n] = x * (1 - mix * 0.6) + wet * mix * 0.6;
  }
}

function dcBlock(buf) {
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const x = buf[i];
    const y = x - x1 + 0.995 * y1;
    x1 = x;
    y1 = y;
    buf[i] = y;
  }
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || plan.version !== 1) {
    throw new TypeError('plan 无效：需要 analyze() 返回的对象（version: 1）');
  }
  if (!Array.isArray(plan.events)) throw new TypeError('plan.events 必须是数组');
  if (!isNum(plan.duration) || plan.duration < 0) throw new TypeError('plan.duration 必须是非负数字');
  let prev = -Infinity;
  for (const ev of plan.events) {
    if (!ev || !isNum(ev.t0) || !isNum(ev.t1) || ev.t1 < ev.t0) throw new TypeError('plan.events 里有非法时间');
    if (ev.t0 < prev - 1e-9) throw new TypeError('plan.events 必须按时间排序');
    prev = ev.t0;
  }
}

/**
 * 把 Plan 渲染成采样。
 * @param {object} plan analyze() 的返回值（也可以是手写的、同结构的对象）
 * @param {object} [opts] voice / sampleRate / seed / reverb / pitch / cues
 */
export function render(plan, opts = {}) {
  validatePlan(plan);
  const voice = resolveVoice(opts.voice);
  const sr = Math.round(opts.sampleRate ?? 44100);
  if (!(sr >= 4000 && sr <= 384000)) throw new TypeError(`sampleRate 需要 4000..384000，收到 ${opts.sampleRate}`);
  const transpose = Number(opts.pitch ?? 0);
  if (!Number.isFinite(transpose)) throw new TypeError('pitch 必须是数字（半音）');
  const seed = Number(opts.seed ?? 0) | 0;
  const reverbMix = clamp(Number(opts.reverb ?? voice.reverb ?? 0) || 0, 0, 1);
  const cues = opts.cues === false || !Array.isArray(plan.cues)
    ? []
    : plan.cues.map((c) => ({...c, midi: voice.register + transpose + c.pitch}));

  if (!(plan.duration > 0) || !plan.events.length) {
    return {samples: new Float32Array(0), sampleRate: sr, duration: 0, cues: []};
  }

  const release = Math.max(0.005, voice.articulation.release);
  const attack = Math.max(0.002, voice.articulation.attack);
  const tail = 0.06 + (reverbMix > 0 ? 1.2 : 0);
  const length = Math.max(1, Math.ceil((plan.duration + tail) * sr));
  const samples = new Float32Array(length);

  const vowels = voice.vowels ? {...VOWELS, ...voice.vowels} : VOWELS;
  const osc = makeSource(voice.source, sr, voice.pulseWidth);
  const tiltA = makeOnePole(sr, 3200 - 1600 * voice.tilt);
  const tiltB = makeOnePole(sr, 3200 - 1600 * voice.tilt);
  const bands = [makeSvf(sr), makeSvf(sr), makeSvf(sr)];
  const noiseBand = makeSvf(sr);
  noiseBand.set(3000, 2); // 辅音噪声的默认带通，第一个爆破采样也不会是 0
  const rnd = mulberry32((hash(plan.text) ^ seed) >>> 0);
  const qs = [3.2, 4.5, 6];
  const fcState = [500, 1500, 2500];
  const ctrl = 8;
  const glide = 1 - Math.exp(-ctrl / (0.012 * sr));
  const target = [0, 0, 0];
  const phraseStart = new Map();
  for (const ev of plan.events) {
    if (ev.kind === 'syl' && !phraseStart.has(ev.phraseId ?? 0)) phraseStart.set(ev.phraseId ?? 0, ev.t0);
  }

  for (const ev of plan.events) {
    if (ev.kind !== 'syl') continue;
    const dur = ev.t1 - ev.t0;
    if (!(dur > 0)) continue;
    const start = Math.round(ev.t0 * sr);
    const count = Math.ceil((dur + release) * sr);
    const jitter = (ev.jitter ?? 0) * voice.jitter;
    const pStart = phraseStart.get(ev.phraseId ?? 0) ?? ev.t0;
    const onset = ev.onset ?? {type: 'none'};
    // 拨音没有辅音起音，整拍就是一个持续的鼻音
    const lead = ev.nasalOnly ? 0 : Math.min(onsetLead(onset), dur * 0.45);
    const amp = (ev.amp ?? 1) * voice.gain;

    for (let i = 0; i < count; i += 1) {
      const idx = start + i;
      if (idx >= length) break;
      const x = i / sr;
      const p = Math.min(1, x / dur);
      const rel = sampleAnchors(ev.pitch, p);
      const vibRamp = clamp((ev.t0 + x - pStart - voice.vibrato.onset) / 0.15, 0, 1);
      const vib = Math.sin(TAU * voice.vibrato.rate * (ev.t0 + x)) * voice.vibrato.depth * vibRamp;
      const f = clamp(mtof(voice.register + transpose + rel + jitter) * (1 + vib), 20, sr * 0.45);

      let gate = 1;
      let noiseAmp = 0;
      const inOnset = x < lead;
      if (inOnset) {
        const u = x / lead;
        if (onset.type === 'stop') {
          const close = Math.min(onset.closure ?? 0.012, lead * 0.6);
          if (x < close) {
            gate = 0;
          } else {
            const span = Math.max(1e-4, lead - close);
            const b = clamp((x - close) / span, 0, 1);
            gate = clamp(b / 0.8, 0, 1);
            noiseAmp = (onset.burst ?? 0.55) * (1 - b) * (1 - b);
          }
        } else if (onset.type === 'fric') {
          gate = clamp((u - 0.45) / 0.55, 0, 1);
          noiseAmp = (onset.burst ?? 0.45) * (1 - u) ** 1.5;
        } else if (onset.type === 'nasal') {
          gate = 0.55;
        } else if (onset.type === 'liquid') {
          gate = 0.82;
        }
      }

      const nasal = onset.type === 'nasal' && (inOnset || ev.nasalOnly === true);
      const liquid = inOnset && onset.type === 'liquid';

      if (i % ctrl === 0) {
        vowelTargets(ev, p, vowels, target);
        const scale = voice.formantScale;
        const nasalTarget = [280 * scale, 1100 * scale, 2400 * scale];
        const liquidTarget = [360 * scale, 1000 * scale, 2500 * scale];
        for (let k = 0; k < 3; k += 1) {
          const want = nasal ? nasalTarget[k] : liquid ? liquidTarget[k] : target[k] * scale;
          fcState[k] += (clamp(want, 20, sr * 0.45) - fcState[k]) * glide;
          bands[k].set(fcState[k], qs[k]);
        }
        if (noiseAmp > 0) {
          noiseBand.set(clamp(onset.freq ?? 3200, 100, sr * 0.45), onset.q ?? 2);
        }
      }

      const raw = osc(f);
      const tilted = tiltB(tiltA(raw));
      const src = lerp(raw, tilted, voice.tilt) + (rnd() * 2 - 1) * voice.breath;
      const shaped = bands[0].bp(src) / qs[0] + (0.9 * bands[1].bp(src)) / qs[1] + (0.55 * bands[2].bp(src)) / qs[2];
      const env = Math.min(1, x / attack) * Math.min(1, (dur + release - x) / release);
      let sig = shaped * env * gate * amp;
      if (noiseAmp > 0) {
        const burstEnv = Math.min(1, x / 0.002);
        sig += noiseBand.bp(rnd() * 2 - 1) * noiseAmp * voice.articulation.consonant * burstEnv * amp * 0.8;
      }
      samples[idx] += sig;
    }
  }

  for (let i = 0; i < length; i += 1) samples[i] = Math.tanh(samples[i] * voice.drive);
  if (reverbMix > 0) addReverb(samples, sr, reverbMix);
  dcBlock(samples);
  for (let i = 0; i < length; i += 1) {
    const v = samples[i];
    samples[i] = v < -1 ? -1 : v > 1 ? 1 : v;
  }
  return {samples, sampleRate: sr, duration: plan.duration, cues};
}

/**
 * 一句话 → 采样 + 乐谱 + 口型时间轴。
 * @param {string} text
 * @param {object} [opts] 见 analyze / render
 */
export function speak(text, opts = {}) {
  const voice = resolveVoice(opts.voice);
  const plan = analyze(text, {
    ...opts,
    // 音名按这条声线的音域换算：C4 在 bibi、warm 上都发 261.6 Hz
    register: opts.register ?? voice.register,
    tempo: opts.tempo ?? voice.tempo,
    contours: {...voice.contours, ...(opts.contours ?? {})},
  });
  const out = render(plan, {...opts, voice});
  return {...out, plan};
}

/** Float32Array → 16 位单声道 WAV 的字节内容。 */
export function toWav(samples, sampleRate = 44100) {
  const sr = Math.round(sampleRate);
  if (!(sr > 0)) throw new TypeError('sampleRate 必须是正整数');
  const n = samples?.length ?? 0;
  const bytes = new Uint8Array(44 + n * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i += 1) {
    const v = Number(samples[i]);
    const x = Number.isFinite(v) ? clamp(v, -1, 1) : 0;
    view.setInt16(44 + i * 2, Math.round(x * 32767), true);
  }
  return bytes;
}
