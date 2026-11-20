// Smoke test for collapsible tool output in the chat pane: tool lines and
// results render collapsed to one line; clicking expands them to full
// (multi-line) text, clicking again collapses them back.
const { spawnApp, killApp, getWsUrl, connectCdp, wait } = require("./cdp_test_lib.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-collapsible-test-"));
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

  const multiCmd = "ls -la --show-all --color=auto /mnt/data_sdb/ywang2/my_coder_agent/agent_ts_gui\necho line2\necho line3\ngrep -rn 'pattern to find' src/"; // > 160 chars when flattened
  const longCmd = "echo " + "x".repeat(200); // > 160 chars: truncated when collapsed
  const multiOut = "first output line\nsecond output line\n" + "y".repeat(400); // > 300 chars

  // 1) collapsed by default: single line, long ones ellipsis-truncated, click to expand
  // (the chat view is hidden until a session is opened; show it so styles apply)
  await evalJs(`document.getElementById('session-list-view').classList.add('hidden'); document.getElementById('session-chat-view').classList.remove('hidden'); true`);
  await evalJs(`document.getElementById('chat').textContent = ''; true`);
  await evalJs(`window.__chatTool("run_command", { command: ${JSON.stringify(multiCmd)} })`);
  await evalJs(`window.__chatTool("run_command", { command: ${JSON.stringify(longCmd)} }, ${JSON.stringify(multiOut)})`);
  await wait(200);

  // spans[0]=tool line 1, spans[1]=tool line 2, spans[2]=result line
  const info = await evalJs(`
    (() => {
      const spans = Array.from(document.querySelectorAll('#chat .collapsible'));
      const t = spans[0], r = spans[2];
      const cs = (el) => getComputedStyle(el);
      return {
        n: spans.length,
        tCollapsed: !t.classList.contains("expanded"),
        tOneLine: Math.ceil(t.getBoundingClientRect().height) <= Math.ceil(parseFloat(cs(t).lineHeight)) * 1.6,
        tTruncated: cs(t).textOverflow === "ellipsis",
        rCollapsed: !r.classList.contains("expanded"),
        tText: t.textContent,
        rText: r.textContent,
      };
    })()`);
  check("collapsible lines rendered (2 tools + 1 result)", info.n === 3, `n=${info.n}`);
  check("tool line collapsed to one line", info.tCollapsed && info.tOneLine);
  check("tool line truncated with ellipsis", info.tTruncated);
  check("result line collapsed", info.rCollapsed);
  check("tool line shows truncated text", info.tText.length <= 170 && info.tText.includes("run_command"), info.tText.slice(0, 40));
  check("result line shows truncated text", info.rText.length <= 310 && info.rText.includes("first output line"), info.rText.slice(0, 40));

  // 2) click the tool line -> expands to full multi-line text
  await evalJs(`document.querySelectorAll('#chat .collapsible')[0].click(); true`);
  await wait(100);
  const exp = await evalJs(`
    (() => {
      const t = document.querySelectorAll('#chat .collapsible')[0];
      const cs = getComputedStyle(t);
      return { expanded: t.classList.contains("expanded"), text: t.textContent, wrap: cs.whiteSpace, h: t.getBoundingClientRect().height };
    })()`);
  check("tool line expanded after click", exp.expanded);
  check("expanded text is the full command", exp.text.includes("ls -la") && exp.text.includes("echo line3") && exp.text.includes("grep -rn"), exp.text.slice(0, 60));
  check("expanded text wraps (multi-line)", exp.wrap === "pre-wrap" && exp.h > 20, `h=${exp.h}`);

  // 3) click again -> collapses back to one line
  await evalJs(`document.querySelectorAll('#chat .collapsible')[0].click(); true`);
  await wait(100);
  const col = await evalJs(`
    (() => {
      const t = document.querySelectorAll('#chat .collapsible')[0];
      return { expanded: t.classList.contains("expanded"), text: t.textContent, h: t.getBoundingClientRect().height };
    })()`);
  check("tool line collapsed after second click", !col.expanded);
  check("collapsed text truncated again", col.text.length <= 170, col.text.slice(0, 40));
  check("collapsed back to one line", col.h < 25, `h=${col.h}`);

  // 4) result line toggles independently
  await evalJs(`document.querySelectorAll('#chat .collapsible')[2].click(); true`);
  await wait(100);
  const res = await evalJs(`
    (() => {
      const spans = document.querySelectorAll('#chat .collapsible');
      return { rExpanded: spans[2].classList.contains("expanded"), rText: spans[2].textContent, tCollapsed: !spans[0].classList.contains("expanded") };
    })()`);
  check("result line expanded on its own click", res.rExpanded && res.rText.includes("second output line") && res.rText.includes("y".repeat(400)));
  check("tool line stays collapsed", res.tCollapsed);

  cdp.close();
  await killApp(app);
  console.log(failed ? "\nFAILED" : "\nALL PASSED");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); killApp(app).finally(() => process.exit(1)); });
