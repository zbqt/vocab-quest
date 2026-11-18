/* 把每个单词的发音预渲染成站点内的 mp3。
 *
 * 为什么必须落到站内文件：
 *   现在的单词发音是**热链**有道录音（dict.youdao.com/dictvoice），每次点喇叭都要联网。
 *   断网 → 必然失败 → 退回设备合成；国产安卓机大多没装英文语音包，于是离线就是哑的。
 *   热链还有两个暗坑：第三方接口可能拦 Referer、可能改防盗链策略，那不是我们能控制的。
 *
 * 为什么不做「全量预装」：
 *   6,369 词 × 4.3KB ≈ 26MB，让每个新用户首屏先下 26MB 是不可接受的。
 *   所以**只生成文件，不进预缓存**：谁播过哪个词，service worker 就把那个词永久存下来
 *   （同源 GET + cache-first）。学过的词离线全都能听，没学过的词走设备合成兜底。
 *
 * 音源与格式：
 *   音源沿用有道录音（和现在听到的完全一样，音质不降级），
 *   转成 22.05kHz 单声道 24kbps mp3 —— 实测单均 4.3KB，语音在这个码率上听不出损失。
 *   不用 Opus 是因为 iOS Safari 对裸 .opus 支持不可靠，mp3 是唯一全平台都能播的。
 *
 * 用法：
 *   node tools/fetch-word-audio.mjs                 # 增量补齐（已存在且够大就跳过）
 *   node tools/fetch-word-audio.mjs --limit=40      # 只做前 40 个（取样验证）
 *   node tools/fetch-word-audio.mjs --force         # 全部重做（换音源参数时用）
 *   node tools/fetch-word-audio.mjs --only=cet4     # 只做某一套词库
 *
 * 一条硬约束（踩过）：请求**不能带 Referer**，这个接口带了就回 200 + 0 字节。
 * node 的 fetch 默认不带 Referer，所以这里是干净的；千万别为了"更像个浏览器"去加。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "audio", "w");

const FORCE = process.argv.includes("--force");
const LIMIT = (() => {
  const a = process.argv.find((x) => x.startsWith("--limit="));
  return a ? Number(a.split("=")[1]) : 0;
})();
const ONLY = (() => {
  const a = process.argv.find((x) => x.startsWith("--only="));
  return a ? a.split("=")[1] : "";
})();

const SETS = {
  cet4: "vocab.js",
  c6: "vocab_c6.js",
  cz: "vocab_cz.js",
  gz: "vocab_gz.js",
};

// 码率定死：24kbps 单声道，实测单均 4.3KB。改这个数要连带改 README 里的体积说明。
const BITRATE = "24k";
const SAMPLE_RATE = "22050";
// 门槛不能定太高：ha / tell 这类词只有零点几秒，24kbps 下就是 1.4KB。
// 定到 1500 会把它们当成失败，重跑一次还是失败 —— 那是门槛错了，不是音频错了。
const MIN_BYTES = 700;
const RAW_MIN_BYTES = 1200;  // 有道原始文件的最小可信体积（66kbps 下约 0.15 秒）

const CONCURRENCY = 4;
const GAP_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 读词库 ----------
 * 词库文件是浏览器脚本（顶层 const + 中文注释），不能用 import。
 * 用 new Function 当沙箱跑一遍，拿数组本身。 */
function wordsOf(file) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  const m = src.match(/const\s+(VOCAB[A-Z_0-9]*)\s*=/);
  if (!m) throw new Error(file + " 里找不到 VOCAB 顶层常量");
  const data = new Function(src + ";return " + m[1] + ";")();
  const out = [];
  for (const unit of data) {
    for (const w of unit.words || []) out.push(String(w[0]).trim().toLowerCase());
  }
  return out;
}

function allWords() {
  const files = ONLY ? [SETS[ONLY]] : Object.values(SETS);
  if (ONLY && !files[0]) throw new Error("未知词库：" + ONLY + "，可选 " + Object.keys(SETS).join("/"));
  const set = new Set();
  for (const f of files) for (const w of wordsOf(f)) set.add(w);
  return [...set].sort();
}

// 按前两个字母分桶：单目录放 6 千个文件，某些静态服务器和 Windows 资源管理器都会难受
function destOf(word) {
  const bucket = word.slice(0, 2);
  return path.join(OUT, bucket, word + ".mp3");
}

/* ---------- 转码 ----------
 * 从 stdin 喂原始 mp3、从 stdout 收转码结果，不落中间文件。
 * 这样即使转码失败，磁盘上也不会留一堆 .tmp。 */
function transcode(buf) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0",
        "-ac", "1", "-ar", SAMPLE_RATE, "-c:a", "libmp3lame",
        "-b:a", BITRATE, "-f", "mp3", "pipe:1"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    const chunks = [];
    let err = "";
    p.stdout.on("data", (c) => chunks.push(c));
    p.stderr.on("data", (c) => { err += String(c); });
    p.on("error", (e) => reject(new Error("调不到 ffmpeg：" + e.message)));
    p.on("close", (code) =>
      code === 0 && chunks.length
        ? resolve(Buffer.concat(chunks))
        : reject(new Error("ffmpeg 失败(" + code + ") " + err.slice(0, 200)))
    );
    p.stdin.on("error", () => {});  // ffmpeg 提前退出时写 stdin 会 EPIPE，忽略
    p.stdin.end(buf);
  });
}

async function grab(word) {
  const url = "https://dict.youdao.com/dictvoice?audio=" + encodeURIComponent(word) + "&type=2";
  const res = await fetch(url, { headers: { Accept: "audio/mpeg,*/*" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < RAW_MIN_BYTES) throw new Error("空音频 " + buf.length + "B");
  return buf;
}

/* ---------- 主流程 ---------- */
const words = allWords();
const picked = LIMIT > 0 ? words.slice(0, LIMIT) : words;
console.log(`词条 ${picked.length} 个（去重后全量 ${words.length}）→ ${path.relative(ROOT, OUT)}`);

let done = 0, skipped = 0, failed = [];
const t0 = Date.now();

// 返回 true 表示真的发了网络请求（只有这时才需要按间隔等一等）
async function work(word) {
  const dest = destOf(word);
  if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size >= MIN_BYTES) {
    skipped++;
    return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = await grab(word);
      const small = await transcode(raw);
      if (small.length < MIN_BYTES) throw new Error("转码结果太小 " + small.length + "B");
      // 先写临时文件再 rename：中途被杀不会留下半截 mp3，下次仍会重做
      const tmp = dest + ".tmp";
      fs.writeFileSync(tmp, small);
      fs.renameSync(tmp, dest);
      done++;
      return true;
    } catch (e) {
      lastErr = e;
      await sleep(400 * (attempt + 1) + Math.random() * 300);
    }
  }
  failed.push(word + " :: " + (lastErr && lastErr.message));
  return true;
}

async function main() {
  let i = 0;
  async function worker() {
    while (i < picked.length) {
      const w = picked[i++];
      const hit = await work(w);
      // 跳过的词不发请求，也就不必等间隔 —— 否则增量补齐时会白白空转十分钟
      if (!hit) continue;
      if ((done + skipped) % 200 === 0) {
        const el = (Date.now() - t0) / 1000;
        console.log(`  进度 ${done + skipped}/${picked.length}  失败 ${failed.length}  ${el.toFixed(0)}s`);
      }
      await sleep(GAP_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const el = ((Date.now() - t0) / 1000).toFixed(0);
  let bytes = 0, files = 0;
  for (const w of words) {
    const d = destOf(w);
    if (fs.existsSync(d)) { bytes += fs.statSync(d).size; files++; }
  }
  console.log(`\n完成：新生成 ${done}，跳过 ${skipped}，失败 ${failed.length}，用时 ${el}s`);
  console.log(`站内音频：${files} 个文件，共 ${(bytes / 1048576).toFixed(1)} MB（单均 ${files ? Math.round(bytes / files) : 0} B）`);
  if (failed.length) {
    console.log(`失败样例（前 10）：`);
    for (const f of failed.slice(0, 10)) console.log("  " + f);
    fs.writeFileSync(path.join(ROOT, "tools", ".word-audio-failed.txt"), failed.join("\n") + "\n");
    console.log(`完整失败清单：tools/.word-audio-failed.txt`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("跑不下去：", e);
  process.exitCode = 1;
});
