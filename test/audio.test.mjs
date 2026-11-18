/* 站内对话音频的完整性检查。
 *
 * 为什么值得单独测：手机上「没声音」最难看出来的原因就是文件没传上去。
 * 那种情况下代码一路正确地降级，最后只能提示"两条通道都不行"，
 * 而真相是 audio/cafe/0.mp3 在服务器上根本不存在。
 * 所以每句台词都必须有一条能在磁盘上找到、且不像空壳的 mp3。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIALOGUES = require(path.join(ROOT, "dialogues.js"));

const AUDIO = path.join(ROOT, "audio");

// 一条 1 秒以上的语音 mp3 不可能小于这个数；低于它基本就是错误页或空文件
const MIN_BYTES = 4000;

function mp3HeadOk(buf) {
  // ID3 标签，或直接是 MPEG 帧同步（0xFF 0xEx/0xFx）
  return (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ||
    (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
}

test("每一句台词都有对应的站内 mp3", () => {
  const missing = [];
  for (const d of DIALOGUES) {
    d.lines.forEach((line, i) => {
      const f = path.join(AUDIO, d.id, i + ".mp3");
      if (!fs.existsSync(f)) missing.push(path.relative(ROOT, f) + "  ← " + line.en);
    });
  }
  assert.deepEqual(missing, [], "缺音频（跑 npm run gen:audio 补）：\n" + missing.join("\n"));
});

test("音频不是空壳：体积够大且是 mp3 头", () => {
  for (const d of DIALOGUES) {
    d.lines.forEach((line, i) => {
      const f = path.join(AUDIO, d.id, i + ".mp3");
      const buf = fs.readFileSync(f);
      const rel = path.relative(ROOT, f);
      assert.ok(buf.length >= MIN_BYTES, `${rel} 只有 ${buf.length}B，像是抓失败了`);
      assert.ok(mp3HeadOk(buf), `${rel} 不是 mp3（前几字节：${buf.slice(0, 4).toString("hex")}）`);
    });
  }
});

test("audio 目录里没有多余的音频（改了题库要顺手清掉旧的）", () => {
  const expected = new Set();
  for (const d of DIALOGUES) d.lines.forEach((_, i) => expected.add(path.join(d.id, i + ".mp3")));

  const found = [];
  for (const dir of fs.readdirSync(AUDIO)) {
    const full = path.join(AUDIO, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) found.push(path.join(dir, f));
  }
  const extra = found.filter((f) => !expected.has(f));
  assert.deepEqual(extra, [], "这些音频没有对应台词：" + extra.join(", "));
});

test("音量差异不该离谱：同一段对话里各句体积在同一量级", () => {
  // 体积 ≈ 时长 ≈ 词数。某句突然只有别人的四分之一，通常是抓到了半截或错误页。
  for (const d of DIALOGUES) {
    const sizes = d.lines.map((_, i) => fs.statSync(path.join(AUDIO, d.id, i + ".mp3")).size);
    const max = Math.max(...sizes);
    const min = Math.min(...sizes);
    assert.ok(min * 4 >= max,
      `${d.id} 各句体积差太多（${min}B ~ ${max}B），检查是否有一句抓残了`);
  }
});
