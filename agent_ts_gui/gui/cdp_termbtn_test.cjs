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
  for (let i = 0; i < 50; i++) { if (await get("!!document.getElementById('term-actions')")) break; await wait(200); }
  const vis = () => get(`(() => {
    const v = (id) => { const el = document.getElementById(id); return el && el.offsetParent !== null; };
    return JSON.stringify({ plus: v('term-new-btn'), max: v('term-max-btn'), hide: v('term-hide-btn') });
  })()`);
  const state0 = await vis();
  await get("document.querySelector('#right-tabs .tab[data-tab=terminals]').click()");
  await wait(200);
  const state1 = await vis();
  await get("document.querySelector('#right-tabs .tab[data-tab=activity]').click()");
  await wait(200);
  const state2 = await vis();
  console.log("initial:", state0);
  console.log("terminals tab:", state1);
  console.log("activity tab:", state2);
  const ok = state0 === state2 && state1.includes('"plus":true') && state0.includes('"plus":false')
    && state0.includes('"max":true') && state0.includes('"hide":true');
  console.log(ok ? "PASS" : "FAIL");
  ws.close(); killApp(app); process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("FAIL", e.message); killApp(app); process.exit(1); });
