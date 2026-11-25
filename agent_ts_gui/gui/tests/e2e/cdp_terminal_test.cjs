// Smoke test for the Terminals tab: open a PTY shell on the backend, type
// into it, read the output back through xterm's buffer, close it.
const { spawnApp, killApp, getWsUrl, connectCdp, wait } = require("./cdp_test_lib.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-term-test-"));
const app = spawnApp({ root: testRoot });

let failed = false;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
  if (!ok) failed = true;
};

(async () => {
  const url = await getWsUrl(app.port);
  if (!url) throw new Error("no devtools url");
  const cdp = connectCdp(url);
  await cdp.opened;
  const evalJs = cdp.evalJs;

  // wait for the project to open (backend ready)
  let opened = false;
  for (let i = 0; i < 120; i++) {
    opened = !!(await evalJs(`window.__root`));
    if (opened) break;
    await wait(500);
  }
  check("project opened", opened);

  // 1) UI elements exist
  check("terminals tab exists", !!(await evalJs(`!!document.querySelector('#right-tabs .tab[data-tab="terminals"]')`)));
  check("new button exists", !!(await evalJs(`!!document.getElementById('term-new-btn')`)));
  check("no terminals initially", (await evalJs(`window.__terminals.count`)) === 0);

  // 2) open a terminal: the list shows it, an xterm instance is created
  await evalJs(`document.querySelector('#right-tabs .tab[data-tab="terminals"]').click(); true`);
  await evalJs(`document.getElementById('term-new-btn').click(); true`);
  let count = 0;
  for (let i = 0; i < 60; i++) {
    count = await evalJs(`window.__terminals.count`);
    if (count === 1) break;
    await wait(250);
  }
  check("terminal opened", count === 1);
  let lis = 0;
  for (let i = 0; i < 20; i++) {
    lis = await evalJs(`document.querySelectorAll('#term-list li').length`);
    if (lis === 1) break;
    await wait(100);
  }
  check("list shows one entry", lis === 1);
  check("xterm element created", !!(await evalJs(`!!document.querySelector('#term-pane .xterm')`)));

  // 3) type a command (xterm paste -> onData -> terminal_write RPC) and read
  //    the output back from the xterm buffer
  const sent = await evalJs(`
    (() => {
      const el = document.querySelector('#term-pane .xterm');
      const t = el && el.__xterm;
      if (!t) return false;
      t.paste('echo cdp-term-e2e\\r');
      return true;
    })()`);
  check("paste dispatched", sent === true);
  let out = "";
  for (let i = 0; i < 40; i++) {
    out = await evalJs(`
      (() => {
        const el = document.querySelector('#term-pane .xterm');
        const t = el && el.__xterm;
        if (!t) return "";
        const buf = t.buffer.active;
        let s = "";
        for (let i = 0; i < buf.length; i++) s += buf.getLine(i).translateToString(true) + "\\n";
        return s;
      })()`);
    if ((out.match(/cdp-term-e2e/g) || []).length >= 2) break;
    await wait(250);
  }
  check("output echoed back", (out.match(/cdp-term-e2e/g) || []).length >= 2, `buffer lines=${(out.split("\n") || []).length}`);

  // 4) close via the per-row hover button: list empties, xterm disposed
  await evalJs(`document.querySelector('#term-list li .term-x').click(); true`);
  await wait(300);
  check("closed: count 0", (await evalJs(`window.__terminals.count`)) === 0);
  check("closed: list empty", (await evalJs(`document.querySelectorAll('#term-list li').length`)) === 0);

  await killApp(app);
  console.log(failed ? "\nTERMINAL TEST FAILED" : "\nterminal test ok");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("test error:", e);
  killApp(app).finally(() => process.exit(1));
});
