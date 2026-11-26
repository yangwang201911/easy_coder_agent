// Measure boot timing: page visible vs backend ready vs project opened.
const { spawnApp, killApp, getWsUrl, connectCdp, wait } = require("./cdp_test_lib.cjs");
const path = require("path");

const app = spawnApp({ root: process.env.TEST_ROOT || path.resolve(__dirname, "..", "..", "..") });

const t0 = Date.now();
const ts = (label) => console.log(`t=${Date.now() - t0}ms  ${label}`);

(async () => {
  const url = await getWsUrl(app.port);
  if (!url) throw new Error("no devtools url");
  ts("devtools page target appears");

  const cdp = connectCdp(url);
  await cdp.opened;
  const evalJs = cdp.evalJs;

  // 1) page visible: toolbar exists in DOM; also record the first state label seen
  let seen = false;
  let firstState = null;
  for (let i = 0; i < 150; i++) {
    const r = await evalJs("JSON.stringify({t: !!document.getElementById('toolbar'), s: document.getElementById('state-label') && document.getElementById('state-label').textContent})");
    if (r) {
      const o = JSON.parse(r);
      if (!firstState && o.s) firstState = o.s;
      if (o.t) { seen = true; break; }
    }
    await wait(100);
  }
  ts(`page DOM ready (toolbar visible) = ${seen}`);
  ts(`first state label observed: ${firstState}`);

  // 3) if no project opens, how fast does the backend-down status chip appear?
  let bannerAt = null;
  for (let i = 0; i < 100; i++) {
    if (await evalJs("!document.getElementById('backend-status').classList.contains('hidden')")) { bannerAt = Date.now() - t0; break; }
    await wait(200);
  }
  if (bannerAt !== null) {
    ts(`backend-down chip appeared at t=${bannerAt}ms`);
    // click the chip to verify the recovery path (flaky backend: first start fails, restart succeeds)
    await evalJs("document.getElementById('backend-status').click()");
    ts("clicked the backend-down chip");
  }

  // 4) project opened: title bar shows "Coder Agent: <root>"
  let opened = false;
  for (let i = 0; i < 120; i++) {
    const lbl = await evalJs("document.getElementById('titlebar-name') && document.getElementById('titlebar-name').textContent");
    if (lbl && lbl.includes("Coder Agent:")) { opened = true; ts(`project opened: ${lbl.trim()}`); break; }
    await wait(500);
  }
  if (!opened) ts("project NOT opened within 60s");

  // 4) the backend-down chip must NOT be visible (no false alarm)
  const banner = await evalJs("!document.getElementById('backend-status').classList.contains('hidden')");
  ts(`backend-down chip visible (should be false): ${banner}`);

  cdp.close();
  await killApp(app);
  process.exit(0);
})().catch(async (e) => { console.error(e); await killApp(app); process.exit(1); });
