// Smoke test for run_command-in-terminal: the terminal_command RPC opens a
// one-shot PTY on the backend, the command_in_terminal event makes the GUI
// attach an xterm tab to it, output is visible and interactive input works.
const { spawnApp, killApp, getWsUrl, connectCdp, wait } = require("./cdp_test_lib.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-termcmd-test-"));
const app = spawnApp({ root: testRoot });

let failed = false;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
  if (!ok) failed = true;
};

// read the whole xterm buffer of the VISIBLE terminal
const bufJs = () => `
  (() => {
    const els = [...document.querySelectorAll('#term-pane .xterm')];
    const el = els.find(e => e.style.display !== 'none') || els[els.length - 1];
    const t = el && el.__xterm;
    if (!t) return "";
    const buf = t.buffer.active;
    let s = "";
    for (let i = 0; i < buf.length; i++) s += buf.getLine(i).translateToString(true) + "\\n";
    return s;
  })()`;

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
  check("no terminals initially", (await evalJs(`window.__terminals.count`)) === 0);

  // 1) open a command terminal: the event must auto-create + select a tab
  const r = await evalJs(`window.__call('terminal_command', { command: 'echo cdp-cmd-e2e && sleep 0.2' })`);
  check("terminal_command answered", !!(r && r.id), JSON.stringify(r));

  let count = 0;
  for (let i = 0; i < 40; i++) {
    count = await evalJs(`window.__terminals.count`);
    if (count === 1) break;
    await wait(250);
  }
  check("tab auto-created", count === 1);
  check("tab selected", (await evalJs(`window.__terminals.current`)) === r.id);
  check("list shows agent label", !!(await evalJs(`
    [...document.querySelectorAll('#term-list li .term-agent')].some(e => e.textContent.includes('agent:'))`)));

  // 2) output is visible in the xterm buffer
  let out = "";
  for (let i = 0; i < 40; i++) {
    out = await evalJs(bufJs());
    if (out.includes("cdp-cmd-e2e")) break;
    await wait(250);
  }
  check("output visible", out.includes("cdp-cmd-e2e"));

  // 3) interactive input: type into the command's stdin
  const r2 = await evalJs(`window.__call('terminal_command', { command: 'read line && echo got:$line' })`);
  check("second command terminal", !!(r2 && r2.id));
  let count2 = 0;
  for (let i = 0; i < 40; i++) {
    count2 = await evalJs(`window.__terminals.count`);
    if (count2 === 2) break;
    await wait(250);
  }
  check("two tabs", count2 === 2);
  await wait(500);  // let `read` start
  const sent = await evalJs(`
    (() => {
      const els = [...document.querySelectorAll('#term-pane .xterm')];
      const el = els.find(e => e.style.display !== 'none') || els[els.length - 1];
      const t = el && el.__xterm;
      if (!t) return false;
      t.paste('hello\\r');
      return true;
    })()`);
  check("paste dispatched", sent === true);
  let out2 = "";
  for (let i = 0; i < 40; i++) {
    out2 = await evalJs(bufJs());
    if (out2.includes("got:hello")) break;
    await wait(250);
  }
  check("interactive input echoed", out2.includes("got:hello"));

  // 4) exit code via terminal_exit
  const ex = await evalJs(`window.__call('terminal_exit', { id: ${JSON.stringify(r2.id)} })`);
  check("exit code 0", !!(ex && ex.exit_code === 0), JSON.stringify(ex));

  // 5) close both tabs
  for (let i = 0; i < 2; i++) {
    await evalJs(`document.querySelector('#term-list li .term-x') && document.querySelector('#term-list li .term-x').click(); true`);
    await wait(200);
  }
  check("closed: count 0", (await evalJs(`window.__terminals.count`)) === 0);

  await killApp(app);
  console.log(failed ? "\nCOMMAND-IN-TERMINAL TEST FAILED" : "\ncommand-in-terminal test ok");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("test error:", e);
  killApp(app).finally(() => process.exit(1));
});
