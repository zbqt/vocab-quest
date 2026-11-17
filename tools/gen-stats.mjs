/* 从四个词库汇总出首页要显示的统计数字，写成几 KB 的 stats.js。
   目的：首页只为显示几个数字，不该把 700KB 词库全下载下来。
   用法：node tools/gen-stats.mjs [项目根目录] */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || ".");
const BOOKS = [
  ["cz", "vocab_cz.js"],
  ["gz", "vocab_gz.js"],
  ["cet4", "vocab.js"],
  ["c6", "vocab_c6.js"]
];

function load(file) {
  const src = fs.readFileSync(path.join(root, file), "utf8");
  const name = (src.match(/(?:const|var|let)\s+([A-Za-z_$][\w$]*)\s*=/) || [])[1];
  if (!name) throw new Error(file + " 找不到导出的变量名");
  return new Function(src + `;return ${name};`)();
}

const books = {};
const units = {};
const uniq = new Set();
let total = 0, phonetic = 0, dupInBook = 0;

for (const [key, file] of BOOKS) {
  const data = load(file);
  units[key] = data.length;
  let n = 0;
  const local = new Set();
  for (const unit of data) {
    for (const w of unit.words || []) {
      n++;
      total++;
      const en = String(w[0] || "");
      uniq.add(en.toLowerCase().trim());
      if (local.has(en.toLowerCase().trim())) dupInBook++;
      local.add(en.toLowerCase().trim());
      if (w[2] && String(w[2]).trim()) phonetic++;
    }
  }
  books[key] = n;
}

const out = {
  books,
  total,
  uniq: uniq.size,
  phonetic,
  units,
  generatedAt: new Date().toISOString().slice(0, 10)
};

const body = `/* 自动生成，请勿手改 —— 由 tools/gen-stats.mjs 汇总四个词库得到。
   首页只读这个文件，不再加载完整词库。词库有变动请重跑：npm run gen:stats */
const VQ_STATS=${JSON.stringify(out)};
if(typeof module==="object"&&module.exports)module.exports=VQ_STATS;
`;

fs.writeFileSync(path.join(root, "stats.js"), body, "utf8");

const kb = (Buffer.byteLength(body) / 1024).toFixed(1);
console.log(`stats.js 已生成（${kb} KB）`);
console.log(`  各词书条数: ${Object.entries(books).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
console.log(`  合计 ${total} 条 · 去重 ${uniq.size} 个 · 带音标 ${phonetic} 条 · 库内重复 ${dupInBook}`);
if (phonetic !== total) console.log(`  注意：有 ${total - phonetic} 条缺音标`);
