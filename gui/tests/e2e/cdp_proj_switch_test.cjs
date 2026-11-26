// Regression test: in the Projects sub-tab, selecting / double-clicking a
// different saved project must actually open it (root label changes).
const { spawnApp, killApp, getWsUrl, connectCdp, wait } = require("./cdp_test_lib.cjs");
const os = require("os");
const path = require("path");

const ROOT_A = process.env.TEST_ROOT_A || path.join(os.tmpdir(), "proj_a");
const ROOT_B = process.env.TEST_ROOT_B || path.join(os.tmpdir(), "proj_b");
const fs = require("fs");
fs.mkdirSync(ROOT_A, { recursive: true });
fs.mkdirSync(ROOT_B, { recursive: true });

const app = spawnApp({ root: ROOT_A, onLog: (d) => process.stdout.write(`[app] ${d}`) });

let failed = false;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
}

(async () => {
  const url = await getWsUrl(app.port);
  if (!url) throw new Error("no devtools url");

  const cdp = connectCdp(url);
  await cdp.opened;
  const evalJs = cdp.evalJs;

  // wait for project A to open
  let opened = false;
  for (let i = 0; i < 120; i++) {
    const lbl = await evalJs("document.getElementById('titlebar-name') && document.getElementById('titlebar-name').textContent");
    if (lbl && (lbl.includes(ROOT_A) || lbl.includes("proj_a"))) { opened = true; break; }
    await wait(500);
  }
  check("project A opened on boot", opened);

  // seed two saved projects, then show the Projects sub-tab
  await evalJs(`localStorage.setItem("coder-agent.projects",
    JSON.stringify([
      { name: "proj_a", mode: "local", path: ${JSON.stringify(ROOT_A)} },
      { name: "proj_b", mode: "local", path: ${JSON.stringify(ROOT_B)} }
    ]))`);
  await evalJs(`document.querySelector('#project-subs .subtab[data-sub="projects"]').click()`);
  let rows = [];
  for (let i = 0; i < 60; i++) {
    rows = await evalJs("[...document.querySelectorAll('#proj-list .projrow .pname')].map(e => e.textContent)");
    if (rows.length >= 2) break;
    await wait(100);
  }
  check("sub-tab lists both projects", rows.some((n) => n.includes("proj_a")) && rows.some((n) => n.includes("proj_b")));

  // 1) single click selects proj_b
  await evalJs(`[...document.querySelectorAll('#proj-list .projrow')].find(r => r.textContent.includes('proj_b')).click()`);
  let sel = null;
  for (let i = 0; i < 30; i++) {
    sel = await evalJs("document.querySelector('#proj-list .projrow.sel .pname') && document.querySelector('#proj-list .projrow.sel .pname').textContent");
    if (sel) break;
    await wait(100);
  }
  check("single click selects proj_b", !!sel && sel.includes("proj_b"));

  // 2) double-click opens proj_b
  await evalJs(`[...document.querySelectorAll('#proj-list .projrow')].find(r => r.textContent.includes('proj_b')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  let switched = false;
  for (let i = 0; i < 40; i++) {
    const lbl = await evalJs("document.getElementById('titlebar-name').textContent");
    if (lbl && (lbl.includes(ROOT_B) || lbl.includes("proj_b"))) { switched = true; break; }
    await wait(500);
  }
  check("double-click switches to project B", switched);

  // 3) double-clicking proj_a (from the same sub-tab) switches back
  for (let i = 0; i < 30; i++) {
    const hasA = await evalJs(`!![...document.querySelectorAll('#proj-list .projrow')].find(r => r.textContent.includes('proj_a'))`);
    if (hasA) break;
    await wait(100);
  }
  await evalJs(`[...document.querySelectorAll('#proj-list .projrow')].find(r => r.textContent.includes('proj_a')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  let back = false;
  for (let i = 0; i < 40; i++) {
    const lbl = await evalJs("document.getElementById('titlebar-name').textContent");
    if (lbl && lbl.includes(ROOT_A)) { back = true; break; }
    await wait(500);
  }
  check("double-click switches back to project A", back);

  cdp.close();
  await killApp(app);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await killApp(app); process.exit(1); });
