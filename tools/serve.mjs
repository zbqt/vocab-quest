/**
 * 极简静态服务器。
 *
 * 存在的唯一理由：托管平台要求「监听 PORT 环境变量 + 绑定 0.0.0.0」。
 * 之前 package.json 里写死 `http-server -p 8642`，平台健康检查等的是 3000，
 * 结果文件明明同步成功了，却被判定成「项目启动失败」。
 *
 * 本地也能用：`npm run serve`（不传 PORT 时退回 8642）。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 8642;
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg"
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://placeholder").pathname);
  } catch (e) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("bad request");
    return;
  }

  let filePath = path.join(ROOT, urlPath === "/" ? "/index.html" : urlPath);

  // 目录穿越防护：解析后必须仍在 ROOT 之内
  const rel = path.relative(ROOT, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (!err && st.isDirectory()) filePath = path.join(filePath, "index.html");
    fs.readFile(filePath, (e2, buf) => {
      if (e2) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("404 not found");
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        // 改完就要立刻能看到，别让浏览器拿旧缓存
        "cache-control": "no-cache",
        // 分享码校验在网关层，这里不参与
        "access-control-allow-origin": "*"
      });
      res.end(buf);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log("[vocab-quest] serving " + ROOT + " on http://" + HOST + ":" + PORT);
});
