/**
 * 云服务链路探测（开发用，不进发布包）
 *
 * 用官方 SDK 在 Node 里跑一遍「未登录访问数据库」，验证三件事：
 *   1. endpoint / publishableKey 组合在这台机器上能连到数据面
 *   2. 发布域名的 Origin 被服务端接受（不是本地 localhost 能替代的）
 *   3. RLS 对匿名请求生效：读不到别人的行、写不进去
 *
 * 用法：node tools/probe-cloud.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDK = path.join(DIR, "tools", ".sdk-probe.js");

// 与 cloud-sync.js 的 PUBLIC_CONFIG 保持一致
const ENDPOINT = "https://wbapp-uugfv7gc0fmksjuo3hokye.app.workbuddy.host";
const KEY = "wbpk_UUGfv7gC0fMKsJUo3HoKye_Z11vIoB2X2GxxL7XeiyxE3bX2p8y5fTK";

function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; }
  };
}

const log = [];
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Headers, Request, Response, URL, URLSearchParams, AbortController,
  TextEncoder, TextDecoder, Blob, FormData,
  crypto: globalThis.crypto,
  localStorage: memStore(),
  sessionStorage: memStore(),
  location: {
    origin: ENDPOINT,
    href: ENDPOINT + "/",
    hostname: new URL(ENDPOINT).hostname,
    protocol: "https:"
  },
  navigator: { userAgent: "vq-cloud-probe" },
  fetch: async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(init.headers || {});
    if (!headers.has("Origin")) headers.set("Origin", ENDPOINT);
    const res = await fetch(input, { ...init, headers });
    log.push({ url: url.replace(/^https?:\/\/[^/]+/, ""), status: res.status, method: init.method || "GET" });
    return res;
  }
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SDK, "utf8"), sandbox, { filename: "sdk.global.js" });

const WC = sandbox.WorkBuddyCloud;
if (!WC || typeof WC.createWorkBuddyCloud !== "function") {
  console.error("SDK 没挂上 WorkBuddyCloud，探测无法进行");
  process.exit(1);
}

const cloud = WC.createWorkBuddyCloud({ endpoint: ENDPOINT, publishableKey: KEY });
const out = { endpoint: ENDPOINT.replace(/^https:\/\//, ""), steps: {} };

// 1. 未登录读：RLS 应返回空数组而不是报错
const read = await cloud.database.from("vq_progress").select("book,client_rev,owner_name");
out.steps.anonRead = {
  error: read.error ? { message: read.error.message, code: read.error.code } : null,
  rows: Array.isArray(read.data) ? read.data.length : read.data
};

// 2. 未登录写：RLS 必须挡住（owner_id 不许为空 / 不许伪造）
const write = await cloud.database
  .from("vq_progress")
  .insert({ book: "__probe__", payload: { probe: true }, client_rev: 1 })
  .select("id");
out.steps.anonWrite = {
  error: write.error ? { message: write.error.message, code: write.error.code } : null,
  rows: Array.isArray(write.data) ? write.data.length : write.data
};
if (Array.isArray(write.data) && write.data.length) {
  out.steps.anonWrite.LEAK = "匿名竟然写进去了，需要立即清理";
}

// 3. 伪造 owner_id 写：必须被 WITH CHECK 拒绝
const forged = await cloud.database
  .from("vq_progress")
  .insert({ book: "__probe__", payload: { probe: true }, client_rev: 1, owner_id: "someone-else" })
  .select("id");
out.steps.forgedOwnerWrite = {
  error: forged.error ? { message: forged.error.message, code: forged.error.code } : null,
  rows: Array.isArray(forged.data) ? forged.data.length : forged.data
};

// 3b. upsert 的 on_conflict 语法是否正确：若冲突目标列不存在，PostgreSQL 会先报 42P10
//     而不是权限错误。收到 42501 就说明 ON CONFLICT (owner_id,book) 解析通过。
const upsert = await cloud.database
  .from("vq_progress")
  .upsert({ book: "__probe__", payload: { probe: true }, client_rev: 1 }, { onConflict: "owner_id,book" })
  .select("client_rev");
out.steps.anonUpsert = {
  error: upsert.error ? { message: upsert.error.message, code: upsert.error.code } : null,
  rows: Array.isArray(upsert.data) ? upsert.data.length : upsert.data
};

// 3c. 对照组：故意写一个不存在的冲突列。它必须报出与上面不同的错误，
//     否则说明 3b 的"42501"只是权限先命中，无法证明 on_conflict 语法真的对。
const badTarget = await cloud.database
  .from("vq_progress")
  .upsert({ book: "__probe__", payload: { probe: true }, client_rev: 1 }, { onConflict: "owner_id,no_such_col" })
  .select("client_rev");
out.steps.anonUpsertBadTarget = {
  error: badTarget.error ? { message: badTarget.error.message, code: badTarget.error.code } : null,
  rows: Array.isArray(badTarget.data) ? badTarget.data.length : badTarget.data
};
out.steps.upsertTargetDiffers = (badTarget.error && badTarget.error.code) !== (upsert.error && upsert.error.code);

// 4. 未登录会话
const sess = await cloud.auth.getSession();
out.steps.anonSession = { hasSession: !!(sess && sess.data), error: sess && sess.error ? sess.error.message : null };

out.requests = log;
console.log(JSON.stringify(out, null, 2));
