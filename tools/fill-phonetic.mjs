// 补齐词库中缺失的音标（构建期一次性执行，结果固化进 js 文件，运行时零请求）
// 用法: node tools/fill-phonetic.mjs [--dry]
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ".");
const dry = process.argv.includes("--dry");
const FILES = ["vocab.js", "vocab_c6.js", "vocab_cz.js", "vocab_gz.js"];
const CACHE_PATH = path.join(root, "tools", ".phonetic-cache.json");
const OVERRIDES_PATH = path.join(root, "tools", "phonetic-overrides.json");
const API = (w) => `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`;

// 接口对缩写/专有名词常只给音频不给文本音标，这些人工资校订
const OVERRIDES = fs.existsSync(OVERRIDES_PATH) ? JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf8")) : {};
// 源头拼错的词头，公开前修正
const RENAME = { reservior: "reservoir", Rusia: "Russia", behavious: "behaviour" };

const cache = fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) : {};

function load(f) {
  const src = fs.readFileSync(path.join(root, f), "utf8");
  const varName = src.match(/const\s+(\w+)\s*=/)[1];
  const header = src.slice(0, src.indexOf("const ")).trimEnd();
  const data = new Function(src + `;return ${varName};`)();
  return { header, varName, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPhonetic(word, retry = 0) {
  if (Object.prototype.hasOwnProperty.call(cache, word) && cache[word]) return cache[word];
  try {
    const res = await fetch(API(word), { signal: AbortSignal.timeout(12000) });
    if (res.status === 429) {
      if (retry < 4) { await sleep(2000 * (retry + 1)); return fetchPhonetic(word, retry + 1); }
      return null;
    }
    if (!res.ok) return null; // 404 等：不写缓存，允许下次重试
    const arr = await res.json();
    let ph = null;
    if (Array.isArray(arr)) {
      for (const e of arr) {
        if (e.phonetic) { ph = e.phonetic; break; }
        const p = (e.phonetics || []).find((x) => x.text);
        if (p) { ph = p.text; break; }
      }
    }
    if (ph) {
      ph = String(ph).trim().replace(/^\/+|\/+$/g, "").replace(/\s+/g, " ");
      if (ph) { cache[word] = ph; return ph; }
    }
    return null;
  } catch (e) {
    if (retry < 3) { await sleep(1200); return fetchPhonetic(word, retry + 1); }
    return null;
  }
}

async function main() {
  let filled = 0, failed = [];
  for (const f of FILES) {
    const { header, varName, data } = load(f);
    const missing = [];
    for (const g of data) for (const w of g.words) {
      if (RENAME[w[0]]) w[0] = RENAME[w[0]];
      if (OVERRIDES[w[0]] && (!w[2] || !String(w[2]).trim())) { w[2] = OVERRIDES[w[0]]; continue; }
      if (!w[2] || !String(w[2]).trim()) missing.push(w);
    }
    if (!missing.length) {
      console.log(`${f}: 无需联网，仅同步覆盖/改名`);
      if (!dry) fs.writeFileSync(path.join(root, f), `${header}\nconst ${varName}=${JSON.stringify(data)};\n`, "utf8");
      continue;
    }

    // 4 并发
    let idx = 0;
    const workers = Array.from({ length: 4 }, async () => {
      while (idx < missing.length) {
        const w = missing[idx++];
        const ph = await fetchPhonetic(w[0].toLowerCase());
        if (ph) { w[2] = ph; filled++; } else failed.push(`${f}:${w[0]}`);
        await sleep(120);
      }
    });
    await Promise.all(workers);

    const left = missing.filter((w) => !w[2] || !String(w[2]).trim()).length;
    console.log(`${f}: 缺失 ${missing.length} → 成功 ${missing.length - left}，仍缺 ${left}`);
    if (!dry) {
      fs.writeFileSync(
        path.join(root, f),
        `${header}\nconst ${varName}=${JSON.stringify(data)};\n`,
        "utf8"
      );
    }
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 0), "utf8");
  console.log(`\n共补齐 ${filled} 条；失败 ${failed.length} 条`);
  if (failed.length) console.log("失败清单:", failed.join(", "));
}

main();
