import fs from "node:fs";
import path from "node:path";
const files = ["vocab.js","vocab_c6.js","vocab_cz.js","vocab_gz.js"];
const root = path.resolve(process.argv[2] || ".");
function load(f){
  const src = fs.readFileSync(path.join(root,f),"utf8");
  const varName = (src.match(/const\s+(\w+)\s*=/)||[])[1];
  return new Function(src + `;return ${varName};`)();
}
// 只看中文释义字段：错误字符 = U+FFFD 或 拉丁补充区字母（æ 除外在音标里合法，但释义里出现即异常）
const MOJI = /[\uFFFD\u00A0-\u00FF]/;
const SEEN=new Map(); let total=0, noPho=0, moji=0, numDup=0, emptyZh=0;
const mSamples=[], pSamples=[], nSamples=[];
for(const f of files){
  const data=load(f);
  let c=0,mp=0,np2=0;
  for(const g of data) for(const w of g.words){
    total++; c++;
    const [en,zh,ph]=w;
    if(!SEEN.has(en)) SEEN.set(en,f); 
    if(!ph||!String(ph).trim()){noPho++;np2++; if(pSamples.length<10)pSamples.push(`${f}:${en}`);}
    if(!zh||!String(zh).trim())emptyZh++;
    if(MOJI.test(zh)){moji++;mp++; if(mSamples.length<15)mSamples.push(`${f}:${en} | ${zh.replace(/[\uFFFD\u00A0-\u00FF]/g,ch=>`[U+${ch.codePointAt(0).toString(16).toUpperCase()}]`)}`);}
    if(/^([a-z]+\.\s+)(?:\1)/i.test(zh)){numDup++; if(nSamples.length<6)nSamples.push(`${f}:${en} | ${zh}`);}
  }
  console.log(`${f}: ${c} 条 · 缺音标 ${np2} · 释义乱码 ${mp}`);
}
console.log(`\n合计 ${total} · 唯一 ${SEEN.size} · 缺音标 ${noPho} · 释义乱码 ${moji} · 重复词性前缀 ${numDup} · 空释义 ${emptyZh}`);
console.log(`\n乱码样本:\n`+mSamples.join("\n"));
console.log(`\n缺音标: `+pSamples.join(", ")+(noPho>pSamples.length?" ...":""));
