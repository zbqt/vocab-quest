#!/usr/bin/env node
/**
 * 把 audio/w/ 下实际存在的单词录音列成清单，供页面「下载离线包」按需遍历。
 *
 * 为什么要有清单：页面不可能扫目录，而词库里有 6 千多个词——
 * 逐个拼 URL 去撞 404 会让下载过程全是无效请求。清单只列真正存在的文件。
 *
 * 用法：node tools/gen-audio-manifest.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "audio", "w");
const OUT = path.join(ROOT, "audio-manifest.json");

// 只存词形，不存完整路径：路径规则（audio/w/<前两字母>/<词>.mp3）页面侧已经有 localSrc()，
// 存两份等于给同一件事写两个真相。带完整路径 154KB，只存词形 55KB。
const list = [];
if (fs.existsSync(DIR)) {
  for (const bucket of fs.readdirSync(DIR).sort()) {
    const full = path.join(DIR, bucket);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full).sort()) {
      if (f.endsWith(".mp3")) list.push(f.slice(0, -4));
    }
  }
}

fs.writeFileSync(OUT, JSON.stringify({ count: list.length, words: list }), "utf8");
const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`已写入 ${path.relative(ROOT, OUT)}：${list.length} 条，${kb}KB`);
