/* 清掉释义尾巴上的「词典人名音译」段。
   来源：有道词典导出的原始释义里，每个词都挂一段 `；n. (Able)人名；(伊朗)阿布勒；(英)埃布尔`。
   这段对背单词零价值，还会把英译中的选项撑长、一眼排除法就能排掉。

   规则带前置条件：删完必须还剩别的义项，否则保留原样（宁可留着脏，不能把释义删空）。
   用法：node tools/fix-zh-names.mjs .        # 改
        node tools/fix-zh-names.mjs . --dry   # 只看会改哪些
*/
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2] || ".");
const DRY = process.argv.includes("--dry");
const FILES = ["vocab.js", "vocab_c6.js", "vocab_cz.js", "vocab_gz.js"];

// 只收「明显是人名音译」的尾巴，不动 候选人名单 / 以他人名义 这种正常的「人名」二字
const PATTERNS = [
  // 标准段：；n. (Able)人名；(伊朗)阿布勒；(英)埃布尔
  /；n\.\s*\([A-Za-z][A-Za-z .]*\)人名[\s\S]*$/,
  // 变体：；n. （法）埃尔（人名）
  /；n\.\s*（[^）]{1,10}）[^；）]{0,10}（人名）[\s\S]*$/,
  // 变体：；琼（人名，来源于拉丁语…）
  /；[^；"“”]{1,20}（人名，[^）]*）[\s\S]*$/,
];

// 释义里必须有「词性 + 内容」，只剩一个词性说明也算空
const HAS_MEANING = /[a-z]+\.\s*\S/i;

function stripTail(zh) {
  if (typeof zh !== "string" || !zh.includes("人名")) return { zh, hit: false };
  for (const re of PATTERNS) {
    if (!re.test(zh)) continue;
    const cut = zh.replace(re, "").replace(/[；;]\s*$/, "").trim();
    // 前置条件：删完还得有释义，否则原样返回
    if (HAS_MEANING.test(cut)) return { zh: cut, hit: true };
  }
  return { zh, hit: false };
}

export { stripTail };

// 只有直接运行时才动文件；被 import 时只导出函数，测试用
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (!invokedDirectly) {
  // 供测试导入，不做任何写盘动作
} else {
  let totalHit = 0;
  for (const f of FILES) {
    const p = path.join(root, f);
    const src = fs.readFileSync(p, "utf8");
    const name = (src.match(/const\s+(\w+)\s*=/) || [])[1];
    if (!name) throw new Error(`${f}: 找不到顶层变量名`);
    const data = new Function(src + `;return ${name};`)();
    const head = src.slice(0, src.indexOf("const "));

    let hit = 0;
    for (const g of data) for (const w of g.words) {
      const r = stripTail(w[1]);
      if (r.hit) { w[1] = r.zh; hit++; }
    }
    totalHit += hit;

    if (!DRY && hit) {
      const rebuilt = head + `const ${name}=` + JSON.stringify(data) + ";\n";
      // 安全闸：重建必须与原文件同样以 JSON 紧凑格式落地，且条目数不变
      const back = new Function(rebuilt + `;return ${name};`)();
      const count = back.reduce((n, g) => n + g.words.length, 0);
      const want = data.reduce((n, g) => n + g.words.length, 0);
      if (count !== want) throw new Error(`${f}: 条目数变化 ${want}→${count}，中止`);
      fs.writeFileSync(p, rebuilt, "utf8");
    }
    console.log(`${f}: 清理 ${hit} 条`);
  }
  console.log(`合计清理 ${totalHit} 条${DRY ? "（dry run，未写入）" : ""}`);
}
