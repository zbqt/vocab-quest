/* 离线发音：站内录音优先、离线不外链、录音缓存跨版本保留。
 *
 * 这一组测的是「断网之后还能不能听」—— 平时完全看不出来：
 * 在线时两种音源都能出声，谁在前谁在后，耳朵分辨不出；
 * 只有真断网才会暴露「原来一直在热链第三方」这种问题。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

/* tts.js 是浏览器脚本：(function(global){...})(window || this)。
 * 在 CJS 里 `this` 就是 module.exports，所以 require 拿到 { VQSpeech }，
 * 而模块内部读的 `global` 正是这个对象 —— 想改 navigator 就往上挂。 */
const MOD = require(path.join(ROOT, "tts.js"));
const S = MOD.VQSpeech;

/* 假的 Audio：只负责记下被请求的地址，并把 play() 变成"失败"，
 * 这样 speak() 会把整条候选链走完，我们就能看到真实的音源顺序。 */
function stubAudio() {
  const tried = [];
  class FakeAudio {
    constructor(src) {
      this.src = src;
      tried.push(src);
      this.preload = "";
      this.readyState = 0;
      this.onerror = null;
      this.onplaying = null;
      this.onended = null;
    }
    play() {
      return Promise.reject(new Error("stub"));
    }
    pause() {}
    load() {}
    removeAttribute() {}
  }
  return { FakeAudio, tried };
}

/* 候选链是异步推进的：play() 的 rejection 走微任务，换下一路要等一拍。
 * 所以这里必须 await 一个宏任务再读 —— 同步读只会看到第一路。 */
async function collectSources(word, offline) {
  const { FakeAudio, tried } = stubAudio();
  const prevAudio = MOD.Audio;
  const prevNav = MOD.navigator;
  MOD.Audio = FakeAudio;
  MOD.navigator = { onLine: !offline };
  try {
    S.speak(word, {});
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    MOD.Audio = prevAudio;
    MOD.navigator = prevNav;
  }
  return tried;
}

test("站内录音地址规则：纯字母小写化，词组没有站内文件", () => {
  assert.equal(S.localSrc("able"), "audio/w/ab/able.mp3");
  assert.equal(S.localSrc("  Abandon "), "audio/w/ab/abandon.mp3");
  assert.equal(S.localSrc("abc"), "audio/w/ab/abc.mp3", "三个字母也要有");
  assert.equal(S.localSrc("ab"), "audio/w/ab/ab.mp3", "两个字母也要有");
  // 词组 / 带连字符 / 空值：没有对应文件，必须返回空串让调用方跳过这一路，
  // 而不是给一个必然 404 的地址（手机上每次点播放都要白等 4 秒看门狗）
  assert.equal(S.localSrc("give up"), "");
  assert.equal(S.localSrc("well-known"), "");
  assert.equal(S.localSrc(""), "");
  assert.equal(S.localSrc(null), "");
});

test("在线时：站内录音排在第三方接口前面", async () => {
  const tried = await collectSources("able", false);
  assert.ok(tried.length >= 2, "应该至少有站内 + 在线两路");
  assert.equal(tried[0], "audio/w/ab/able.mp3", "第一路必须是站内文件");
  assert.ok(/^https:\/\//.test(tried[1]), "第二路才是在线接口");
});

test("离线时：一个外链都不排", async () => {
  const tried = await collectSources("able", true);
  assert.deepEqual(tried, ["audio/w/ab/able.mp3"], "离线只该试站内录音，外链注定失败还拖 4 秒");
});

test("离线 + 词组（没有站内文件）：直接交给系统合成，不发任何请求", async () => {
  const tried = await collectSources("give up", true);
  assert.deepEqual(tried, [], "没有可用音源时不该发请求");
});

test("站内录音文件真实存在，且不是空壳", () => {
  const dir = path.join(ROOT, "audio", "w");
  assert.ok(fs.existsSync(dir), "audio/w 不存在：跑 npm run gen:words 生成");
  let checked = 0;
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const name of fs.readdirSync(full).slice(0, 3)) {
      const p = path.join(full, name);
      const buf = fs.readFileSync(p);
      const rel = path.relative(ROOT, p);
      // 门槛按最短的词定：ha 只有 0.47 秒，24kbps 下就是 1.4KB
      assert.ok(buf.length >= 700, `${rel} 只有 ${buf.length}B，像是抓残了`);
      // mp3 头：ID3 或帧同步
      assert.ok(
        (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0),
        `${rel} 不是 mp3`
      );
      checked++;
    }
  }
  assert.ok(checked >= 20, "抽样太少，看不出问题");
});

test("词库里的每个词都该有站内录音（缺一个，那个词离线就哑）", () => {
  const missing = [];
  for (const f of ["vocab.js", "vocab_c6.js", "vocab_cz.js", "vocab_gz.js"]) {
    const src = read(f);
    const name = src.match(/const\s+(VOCAB[A-Z_0-9]*)\s*=/)[1];
    const data = new Function(src + ";return " + name + ";")();
    for (const unit of data) {
      for (const w of unit.words || []) {
        const word = String(w[0]).trim().toLowerCase();
        if (!S.localSrc(word)) continue;
        if (!fs.existsSync(path.join(ROOT, S.localSrc(word)))) missing.push(f + " :: " + word);
      }
    }
  }
  assert.deepEqual(missing.slice(0, 20), [], `缺 ${missing.length} 个词的站内录音（跑 npm run gen:words 补）`);
});

test("录音缓存必须跨版本保留：升级一次就把离线音频清空等于白做", () => {
  const sw = read("sw.js");
  assert.match(sw, /const AUDIO_CACHE = "vq-audio-v\d+"/, "没有独立的录音缓存分区");
  assert.match(sw, /k !== VERSION && k !== AUDIO_CACHE/,
    "activate 里必须排除录音缓存，否则每次升级都清掉用户攒下的音频");
  assert.match(sw, /url\.pathname\.indexOf\("\/audio\/"\)/, "fetch 里没有录音的缓存优先分支");
});

test("整句人声进了预缓存清单（离线听写靠它）", () => {
  const sw = read("sw.js");
  const block = (sw.match(/const SENTENCE_AUDIO = \[([\s\S]*?)\];/) || [])[1] || "";
  const files = [...block.matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]);
  assert.ok(files.length >= 70, "整句音频清单没解析出来，或者条数不对：" + files.length);
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), "预缓存了不存在的句子音频：" + f);
  }
});

test("断网打开带参数的深层链接：导航按路径匹配，不许掉回首页", () => {
  const sw = read("sw.js");
  const nav = (sw.match(/req\.mode === "navigate"[\s\S]*?\n  \}/) || [""])[0];
  assert.ok(nav.length > 100, "没解析到导航分支");
  // 预缓存的页面是不带参数的 ./game.html，而地址常带 ?cat=cet4&act=daily。
  // 按完整 URL 匹配必然落空 → 用户断网打开这一页会看到首页，像"离线打不开"。
  assert.match(nav, /caches\s*\n?\s*\.match\(req, \{ ignoreSearch: true \}\)/,
    "导航回落必须 ignoreSearch，否则断网时深层链接会掉到首页");
});
