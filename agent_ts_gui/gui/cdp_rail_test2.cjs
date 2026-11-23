const { spawnApp, killApp, getWsUrl, wait } = require("./cdp_test_lib.cjs");
const WebSocket = require("ws");
const app = spawnApp({});
(async () => {
  let url = null;
  for (let i = 0; i < 50; i++) { url = await getWsUrl(app.port, "/json/version"); if (url) break; await wait(200); }
  const ws = new WebSocket(url, { perMessageDeflate: false });
  let id = 0; const pending = new Map();
  ws.on("message", (buf) => { const m = JSON.parse(buf); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  await new Promise((r) => ws.on("open", r));
  let pageId = null;
  for (let i = 0; i < 50 && !pageId; i++) {
    const { targetInfos } = (await send("Target.getTargets")).result;
    const t = targetInfos.find((t) => t.type === "page" && /index\.html/.test(t.url));
    if (t) pageId = t.targetId; else await wait(200);
  }
  const attach = await send("Target.attachToTarget", { targetId: pageId, flatten: true });
  const sessionId = attach.result.sessionId;
  const get = async (expr) => {
    const mid = ++id;
    const msg = await new Promise((res) => { const h = (b) => { const m = JSON.parse(b); if (m.id === mid) { ws.off("message", h); res(m); } }; ws.on("message", h); ws.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true }, sessionId })); });
    return msg.result.result.value;
  };
  for (let i = 0; i < 50; i++) { if (await get("!!document.getElementById('left-rail')")) break; await wait(200); }
  await get("document.querySelector('#left-rail .tab[data-tab=files]').click()");
  await wait(500);
  const geo = await get(`(() => {
    const r = (id) => { const el = document.getElementById(id).getBoundingClientRect(); return {x: Math.round(el.x), y: Math.round(el.y), w: Math.round(el.width), h: Math.round(el.height)}; };
    return JSON.stringify({ rail: r('left-rail'), files: r('tab-files'), tree: r('file-tree') });
  })()`);
  console.log(geo);
  ws.close(); killApp(app); process.exit(0);
})().catch((e) => { console.error("FAIL", e.message); killApp(app); process.exit(1); });
