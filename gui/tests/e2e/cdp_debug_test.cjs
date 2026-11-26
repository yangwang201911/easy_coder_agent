// Debug tab smoke test: Settings > Debug shows the prompt_dump switch (default off),
// saving persists it, "View dumps" opens the dumps dialog (empty state), Clear works.
const { spawnApp, killApp, getWsUrl, connectCdp, wait } = require("./cdp_test_lib.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");

// isolate the agent's user config (~/.coder_agent) so the test cannot read
// (or pollute) the developer's real prompt_dump setting
const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cdp-home-"));
process.env.CODER_AGENT_HOME = home;

const app = spawnApp({ root: process.env.TEST_ROOT || path.join(os.tmpdir(), "proj_a"), onLog: (d) => process.stderr.write(`[app] ${d}`) });

let failed = false;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failed = true;
}

(async () => {
  const url = await getWsUrl(app.port);
  if (!url) throw new Error("no devtools url");

  const cdp = connectCdp(url);
  await cdp.opened;
  const evalJs = cdp.evalJs;
  // The backend may still be initializing right after boot; the first
  // context_strategies RPC can take a few seconds. Poll for the dialog
  // instead of a fixed wait so the test is robust to boot latency.
  const openSettings = async () => {
    await evalJs("document.getElementById('rail-settings').click()");
    for (let i = 0; i < 60; i++) {
      if (await evalJs("!!document.querySelector('.settings')")) return;
      await wait(100);
    }
  };
  // Poll until a text node contains the expected substring (async RPCs fill
  // these after the tab/dialog opens).
  const pollText = async (expr, substr, tries = 200) => {
    for (let i = 0; i < tries; i++) {
      const v = await evalJs(expr);
      if (typeof v === "string" && v.includes(substr)) return v;
      await wait(100);
    }
    return await evalJs(expr);
  };

  for (let i = 0; i < 150; i++) {
    const lbl = await evalJs("document.getElementById('titlebar-name') && document.getElementById('titlebar-name').textContent");
    if (lbl && lbl.includes("Coder Agent:")) break;
    await wait(200);
  }
  check("project opened", (await evalJs("document.getElementById('titlebar-name').textContent")).includes("Coder Agent:"));
  // Warm up the backend: the first prompt_dumps RPC races with startup
  // initialization and can take ~10s; calling it once here ensures the debug
  // tab's own prompt_dumps call (which fills .dpath) returns quickly.
  await evalJs(`window.__call("prompt_dumps", {})`, 30000);

  // 1) open settings, go to the debug tab
  await openSettings();
  check("settings modal shown", await evalJs("!!document.querySelector('.settings')"));
  check("debug tab exists", await evalJs("!!document.querySelector('.settings .tabs button[data-p=\"debug\"]')"));
  await evalJs("document.querySelector('.settings .tabs button[data-p=\"debug\"]').click()");
  await wait(300);
  check("debug page active", await evalJs("!!document.querySelector('.settings .page[data-p=\"debug\"].active')"));
  const cb = () => evalJs("(()=>{const c=document.querySelector('[data-s=\"debug\"][data-k=\"prompt_dump\"]'); return c ? c.checked : null;})()");
  check("prompt_dump checkbox exists", (await cb()) === false);
  check("prompt_dump default off", (await cb()) === false);
  const dpath = await pollText("document.querySelector('.dpath').textContent", "Dump directory");
  check("dump dir shown", typeof dpath === "string" && dpath.includes(".agent/debug/prompts"));
  check("view/clear buttons", await evalJs("!!document.querySelector('.d-view') && !!document.querySelector('.d-clear')"));

  // 2) enable + save, reopen: switch must be on
  await evalJs("(()=>{const c=document.querySelector('[data-s=\"debug\"][data-k=\"prompt_dump\"]'); c.checked=true;})()");
  await evalJs("document.querySelector('#modal .foot .yes').click()");
  await wait(600);
  await openSettings();
  await evalJs("document.querySelector('.settings .tabs button[data-p=\"debug\"]').click()");
  await wait(300);
  check("prompt_dump persisted on", (await cb()) === true);
  await evalJs("document.querySelector('.settings .close-x').click()");
  await wait(200);

  // 3) View dumps dialog: empty state
  await openSettings();
  await evalJs("document.querySelector('.settings .tabs button[data-p=\"debug\"]').click()");
  await wait(300);
  await evalJs("document.querySelector('.d-view').click()");
  await wait(500);
  check("dumps modal shown", await evalJs("!!document.querySelector('.modal.dumps')"));
  const dlist = await pollText("document.querySelector('.modal.dumps .dlist').textContent", "no dumps yet");
  check("dumps empty state", typeof dlist === "string" && dlist.includes("no dumps yet"));
  await evalJs("document.querySelector('.modal.dumps .no').click()");
  await wait(200);
  check("dumps modal closed", !(await evalJs("!!document.querySelector('.modal.dumps')")));

  // 4) clear (nothing to delete)
  await evalJs("document.querySelector('.settings .d-clear').click()");
  await wait(300);
  // stacked confirm modal appears; accept it
  await evalJs("document.querySelector('.modal-backdrop.stacked .yes').click()");
  await wait(400);
  const clearMsg = await pollText("document.querySelector('.page[data-p=\"debug\"] .msg').textContent", "Deleted");
  check("clear ok message", typeof clearMsg === "string" && clearMsg.includes("Deleted 0"));

  await evalJs("document.querySelector('.settings .close-x').click()");
  await wait(200);

  cdp.close();
  await killApp(app);
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await killApp(app); fs.rmSync(home, { recursive: true, force: true }); process.exit(1); });
