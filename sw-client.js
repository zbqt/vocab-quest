/* Service Worker 注册 + 换版本后的自愈刷新。
 *
 * 为什么需要「自愈」：导航是网络优先，静态资源是缓存优先。
 * 于是刚发新版那一下会出现「新 HTML + 旧 JS」的错配 —— 新版页面里写的入口
 * 去找旧脚本里还不存在的函数，结果是整块区域空白，而且用户看不到任何报错。
 * 新 SW 装上并接管后刷一次就正常，但没人有理由知道要刷第二次。
 *
 * 所以这里只做两件事：
 *   1. 每次加载主动 update() 一次，别让旧 sw.js 靠 HTTP 缓存赖着不走；
 *   2. 发现控制器换了（说明新 SW 接管了）就自动刷一次；首访本来就没有控制器，不刷。
 */
(function () {
  if (!("serviceWorker" in navigator)) return;
  var secure = (typeof isSecureContext !== "undefined" && isSecureContext) ||
    location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (!secure) return;

  var hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (!hadController) return;                 // 首次安装不算换版本，别白闪一下
    try {
      if (sessionStorage.getItem("vq-sw-swapped")) return;   // 一次会话只刷一次，防死循环
      sessionStorage.setItem("vq-sw-swapped", "1");
    } catch (e) { return; }                     // 拿不到 sessionStorage 就别冒险刷
    location.reload();
  });

  addEventListener("load", function () {
    navigator.serviceWorker.register("./sw.js").then(function (reg) {
      // 显式 update()：部分浏览器会把 sw.js 当普通脚本走 HTTP 缓存，
      // 结果新版本发了几个小时，手机上还在用旧的。这一步不吃缓存。
      if (reg && typeof reg.update === "function") reg.update().catch(function () {});
    }).catch(function () {});
  });
})();
