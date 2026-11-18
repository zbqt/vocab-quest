/* 把长对话的每一句预渲染成站点内的 mp3。
 *
 * 为什么要落到本地文件，而不是练习时现取：
 *   1. 手机浏览器（尤其国产安卓）经常把 <audio> 发去第三方接口的请求拦掉，
 *      或者丢掉 <meta name="referrer"> 里的策略，接口回 0 字节 —— 用户看到的就是"没声音"。
 *   2. 设备自带的合成引擎在那类浏览器上要么不存在，要么没装英文语音包，
 *      所以"退回设备语音"这条兜底在手机上也是死的。
 *   3. 同源静态文件没有防盗链、没有跨域、不需要联网，PWA 缓存下来还能离线听。
 *
 * 用法：
 *   node tools/fetch-audio.mjs          # 缺什么补什么
 *   node tools/fetch-audio.mjs --force  # 全部重抓（换了音源参数时用）
 *
 * 一条硬约束：请求**不能带 Referer**，这个接口带 Referer 就回 200 + 0 字节。
 * node 的 fetch 默认不带，所以这里是干净的。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIALOGUES = require(path.join(ROOT, "dialogues.js"));
const S = require(path.join(ROOT, "sentence-audio.js"));

const FORCE = process.argv.includes("--force");
const OUT = path.join(ROOT, "audio");

// 同一时刻 3 条：够快，又不至于让接口把我们当爬虫
const CONCURRENCY = 3;
const PAUSE_MS = 180;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function grab(url, dest, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      // 防盗链的典型表现就是 200 + 0 字节，别把空文件当成功
      if (buf.length < 1200) throw new Error("too small: " + buf.length + "B");
      fs.writeFileSync(dest, buf);
      return buf.length;
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(600 * (i + 1));
    }
  }
}

const jobs = [];
for (const d of DIALOGUES) {
  d.lines.forEach((line, i) => {
    const dir = path.join(OUT, d.id);
    const dest = path.join(dir, i + ".mp3");
    const text = S.clean(line.en);
    jobs.push({
      dest,
      dir,
      text,
      url: S.url(text, { accent: S.accentOf(line.sp) })
    });
  });
}

let made = 0, skipped = 0, failed = [];

const queue = jobs.slice();
async function worker() {
  while (queue.length) {
    const job = queue.shift();
    fs.mkdirSync(job.dir, { recursive: true });
    if (!FORCE && fs.existsSync(job.dest) && fs.statSync(job.dest).size > 1200) {
      skipped++;
      continue;
    }
    try {
      const n = await grab(job.url, job.dest);
      made++;
      process.stdout.write(`  ✔ ${path.relative(ROOT, job.dest)}  ${(n / 1024).toFixed(1)}KB\n`);
    } catch (e) {
      failed.push({ dest: path.relative(ROOT, job.dest), text: job.text, err: String(e.message || e) });
      process.stdout.write(`  ✘ ${path.relative(ROOT, job.dest)}  ${e.message || e}\n`);
    }
    await sleep(PAUSE_MS);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const total = jobs.reduce((s, j) => s + (fs.existsSync(j.dest) ? fs.statSync(j.dest).size : 0), 0);
console.log(`\n共 ${jobs.length} 句：新抓 ${made}，已有 ${skipped}，失败 ${failed.length}`);
console.log(`音频总体积 ${(total / 1024 / 1024).toFixed(2)} MB`);
if (failed.length) {
  console.log("\n失败的句子（重跑本脚本会补）：");
  for (const f of failed) console.log(`  ${f.dest}  ${f.text}  ${f.err}`);
  process.exitCode = 1;
}
