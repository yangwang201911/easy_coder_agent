// Smoke test for text selection & copy:
//  1. terminal: xterm selection (drag-select via API + getSelection), the
//     right-click context menu shows Copy/Paste/Select all, and the
//     Ctrl+Shift+C handler copies the selection to the clipboard.
//  2. log panes (Activity / Commands): DOM text selection works and the
//     right-click context menu offers Copy for a non-empty selection.
const { spawnApp, killApp, getWsUrl, connectCdp, wait } = require("./cdp_test_lib.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-copy-test-"));
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

  let opened = false;
  for (let i = 0; i < 120; i++) {
    opened = !!(await evalJs(`window.__root`));
    if (opened) break;
    await wait(500);
  }
  check("project opened", opened);

  // ------------------------------------------------- terminal selection
  await evalJs(`document.querySelector('#right-tabs .tab[data-tab="terminals"]').click(); true`);
  await evalJs(`document.getElementById('term-new-btn').click(); true`);
  let count = 0;
  for (let i = 0; i < 60; i++) {
    count = await evalJs(`window.__terminals.count`);
    if (count === 1) break;
    await wait(250);
  }
  check("terminal opened", count === 1);

  // let the shell prompt render, then type a marker command
  await evalJs(`
    (() => {
      const t = document.querySelector('#term-pane .xterm')?.__xterm;
      if (t) t.paste('echo cdp-copy-marker\\r');
      return true;
    })()`);
  let out = "";
  for (let i = 0; i < 40; i++) {
    out = await evalJs(`
      (() => {
        const t = document.querySelector('#term-pane .xterm')?.__xterm;
        if (!t) return "";
        const buf = t.buffer.active;
        let s = "";
        for (let i = 0; i < buf.length; i++) s += buf.getLine(i).translateToString(true) + "\\n";
        return s;
      })()`);
    if (out.includes("cdp-copy-marker")) break;
    await wait(250);
  }
  check("marker in terminal output", out.includes("cdp-copy-marker"));

  // select the marker line in xterm and read it back via getSelection()
  const selText = await evalJs(`
    (() => {
      const t = document.querySelector('#term-pane .xterm')?.__xterm;
      if (!t) return null;
      const buf = t.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString(true).includes("cdp-copy-marker")) {
          t.select(0, i, 80);
          return t.getSelection();
        }
      }
      return null;
    })()`);
  check("xterm selection returns text", typeof selText === "string" && selText.includes("cdp-copy-marker"), `sel=${JSON.stringify(selText)}`);

  // right-click inside the terminal: the custom context menu appears with
  // Copy enabled (a selection is active)
  const menuShown = await evalJs(`
    (() => {
      const el = document.querySelector('#term-pane .xterm');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 40, clientY: r.top + 20 }));
      const m = document.getElementById("ctxmenu");
      const items = Array.from(m.querySelectorAll(".item")).map(x => x.textContent + (x.classList.contains("disabled") ? "*" : ""));
      return { visible: m.style.display === "block", items };
    })()`);
  check("terminal context menu shown", menuShown && menuShown.visible);
  check("terminal menu has Copy/Paste/Select all",
    menuShown && menuShown.items.includes("Copy") && menuShown.items.includes("Paste") && menuShown.items.includes("Select all"),
    JSON.stringify(menuShown?.items));
  check("Copy enabled with a selection", menuShown && menuShown.items.includes("Copy") && !menuShown.items.includes("Copy*"));
  await evalJs(`document.getElementById("ctxmenu").style.display = "none"; true`);

  // Ctrl+Shift+C: the custom key handler intercepts it (returns false =>
  // xterm does not forward to the shell) and copies the selection.
  // Stub the clipboard to observe what would be written.
  const copied = await evalJs(`
    (() => {
      window.__copied = null;
      navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); };
      const t = document.querySelector('#term-pane .xterm')?.__xterm;
      if (!t) return "no-terminal";
      const el = t.element.querySelector(".xterm-helper-textarea") ?? t.textarea;
      if (!el) return "no-textarea";
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      return window.__copied;
    })()`);
  check("Ctrl+Shift+C copies selection", typeof copied === "string" && copied.includes("cdp-copy-marker"), `copied=${JSON.stringify(copied)}`);

  // ------------------------------------------------- log pane selection
  // switch back to the Activity tab (hidden panes cannot hold a selection)
  await evalJs(`document.querySelector('#right-tabs .tab[data-tab="activity"]').click(); true`);
  // seed the Activity pane (it may be empty on a fresh project) and select
  // the content via the DOM selection API
  await evalJs(`
    (() => {
      const el = document.getElementById("tab-activity");
      const s = document.createElement("span");
      s.textContent = "cdp-log-copy-line\\n";
      el.appendChild(s);
      return true;
    })()`);
  const logSel = await evalJs(`
    (() => {
      const el = document.getElementById("tab-activity");
      if (!el || !el.textContent.trim()) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return sel.toString();
    })()`);
  check("log pane text selectable", typeof logSel === "string" && logSel.includes("cdp-log-copy-line"), `len=${logSel?.length}`);

  // right-click on the log pane: context menu with Copy enabled
  const logMenu = await evalJs(`
    (() => {
      const el = document.getElementById("tab-activity");
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 20 }));
      const m = document.getElementById("ctxmenu");
      const items = Array.from(m.querySelectorAll(".item")).map(x => x.textContent + (x.classList.contains("disabled") ? "*" : ""));
      return { visible: m.style.display === "block", items };
    })()`);
  check("log pane context menu shown", logMenu && logMenu.visible);
  check("log menu Copy enabled", logMenu && logMenu.items.includes("Copy") && !logMenu.items.includes("Copy*"), JSON.stringify(logMenu?.items));

  // with no selection the menu shows a disabled "No selection" item
  await evalJs(`window.getSelection().removeAllRanges(); true`);
  const logMenuEmpty = await evalJs(`
    (() => {
      const el = document.getElementById("tab-activity");
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 20 }));
      const m = document.getElementById("ctxmenu");
      return Array.from(m.querySelectorAll(".item")).map(x => x.textContent + (x.classList.contains("disabled") ? "*" : ""));
    })()`);
  check("log menu without selection", logMenuEmpty && logMenuEmpty.includes("No selection*"), JSON.stringify(logMenuEmpty));

  // ------------------------------------------------- chat pane menu
  const chatMenu = await evalJs(`
    (() => {
      const el = document.getElementById("chat");
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 20, clientY: r.top + 20 }));
      const m = document.getElementById("ctxmenu");
      return Array.from(m.querySelectorAll(".item")).map(x => x.textContent);
    })()`);
  check("chat menu has Paste", chatMenu && chatMenu.includes("Paste"), JSON.stringify(chatMenu));

  await killApp(app);
  console.log(failed ? "\nCOPY TEST FAILED" : "\ncopy test ok");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("test error:", e);
  killApp(app).finally(() => process.exit(1));
});
