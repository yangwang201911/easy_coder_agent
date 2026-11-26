// Smoke test: the Projects sub-tab (left rail) lists saved projects, has the
// Add/Rename/Delete toolbar, and the local "Add project" flow uses the native
// folder picker (mocked via the __pickDirectory hook).
const { spawnApp, killApp, getWsUrl, connectCdp, wait } = require("./cdp_test_lib.cjs");
const path = require("path");

const ROOT = process.env.TEST_ROOT || path.resolve(__dirname, "..", "..", "..");
const app = spawnApp({ root: ROOT, onLog: (d) => process.stdout.write(`[app] ${d}`) });

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

  // wait for the project to open
  let opened = false;
  for (let i = 0; i < 120; i++) {
    const lbl = await evalJs("document.getElementById('titlebar-name') && document.getElementById('titlebar-name').textContent");
    if (lbl && lbl.includes("Coder Agent:")) { opened = true; break; }
    await wait(500);
  }
  check("project opened on boot", opened);

  // 1) Projects sub-tab shows the saved projects with the toolbar buttons
  await evalJs(`document.querySelector('#project-subs .subtab[data-sub="projects"]').click()`);
  let rows = [];
  for (let i = 0; i < 60; i++) {
    rows = await evalJs("[...document.querySelectorAll('#proj-list .projrow .pname')].map(e => e.textContent)");
    if (rows.length) break;
    await wait(100);
  }
  check("projects sub-tab visible", await evalJs("!document.getElementById('project-sub-projects').classList.contains('hidden')"));
  check("toolbar buttons", (await evalJs("[...document.querySelectorAll('#proj-toolbar button')].map(b => b.title).join(',')")) === "Add a project,Rename the selected project,Delete the selected project");

  // 2) the auto-opened root is remembered as a saved project (via openProject)
  const rootName = path.basename(ROOT);
  check("auto-opened project is in the list", rows.some((n) => n.includes(rootName)));

  // 3) local mode: "Add project" uses the native folder picker (mocked via the
  // __pickDirectory hook); the remote dir browser is covered by cdp_remote_test
  const add = await evalJs(`(async () => {
    window.__pickDirectory = () => Promise.resolve("/tmp");
    document.getElementById('proj-add-btn').click();
    await new Promise(r => setTimeout(r, 500));
    // the name input modal must be up (native picker was mocked, no browser rows)
    const promptUp = !!document.querySelector('.modal-backdrop.stacked .pinput');
    const hasBrowser = !!document.querySelector('#proj-list .pathbar');
    document.querySelector('.modal-backdrop.stacked .no')?.click();
    await new Promise(r => setTimeout(r, 200));
    return JSON.stringify({ promptUp, hasBrowser });
  })()`);
  const a = JSON.parse(add);
  check("local mode: add uses native picker (name prompt, no dir browser)", a.promptUp && !a.hasBrowser);

  cdp.close();
  await killApp(app);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await killApp(app); process.exit(1); });
