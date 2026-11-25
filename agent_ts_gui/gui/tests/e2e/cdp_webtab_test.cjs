// Smoke test: web page tabs in the mid pane.
// - a local HTTP server serves a test page
// - __openWeb opens it as a browser tab
// - the "+screenshot" attach tag appears and captures the page into the chat
const { spawnApp, killApp, getWsUrl, connectCdp, wait } = require("./cdp_test_lib.cjs");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-webtab-test-"));
fs.writeFileSync(path.join(testRoot, "hello.txt"), "hi\n");

// a tiny local web server on a random-ish port
const WEB_PORT = 18765 + Math.floor(Math.random() * 100);
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body style='background:#eef'><h1 style='color:red'>webtab test</h1></body></html>");
});
server.listen(WEB_PORT, "127.0.0.1");
const pageUrl = `http://127.0.0.1:${WEB_PORT}/`;

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

  // wait for the project to open
  let opened = false;
  for (let i = 0; i < 120; i++) {
    opened = !!(await evalJs(`document.querySelector('#file-tree .tree-row') ? true : false`));
    if (opened) break;
    await wait(500);
  }
  check("project opened", opened);

  // open the web page as a tab
  await evalJs(`__openWeb(${JSON.stringify(pageUrl)})`);
  await wait(300);

  // the tab must appear with the web icon
  const hasTab = !!(await evalJs(`(() => {
    const tabs = Array.from(document.querySelectorAll('#file-tabs .ftab'));
    return tabs.some(t => t.classList.contains('ftab-web') && t.textContent.includes('127.0.0.1'));
  })()`));
  check("web tab appears", hasTab);

  // the body must contain an iframe pointing at the page
  const hasFrame = !!(await evalJs(`(() => {
    const f = document.querySelector('#file-body iframe.webframe');
    return f && f.src === ${JSON.stringify(pageUrl)};
  })()`));
  check("iframe points at the page", hasFrame);

  // the "+screenshot" attach tag appears above the input box
  let tagShown = false;
  for (let i = 0; i < 10; i++) {
    tagShown = !!(await evalJs(`(() => {
      const t = document.getElementById('file-attach-tag');
      return t && !t.classList.contains('hidden') && t.textContent.includes('screenshot');
    })()`));
    if (tagShown) break;
    await wait(300);
  }
  check("screenshot tag appears", tagShown);

  // click it -> the capture runs and the image is attached
  await evalJs(`document.getElementById('file-attach-tag').click()`);
  let attached = false;
  for (let i = 0; i < 40; i++) {
    attached = !!(await evalJs(`(() => {
      return window.__attachments.length > 0 && window.__attachments[0].name.startsWith('screenshot');
    })()`));
    if (attached) break;
    await wait(500);
  }
  check("screenshot attached to prompt", attached,
    await evalJs(`JSON.stringify(window.__attachments.map(a => a.name))`));

  // the tag is now in the "attached" state
  check("tag shows attached", !!(await evalJs(`document.getElementById('file-attach-tag').classList.contains('attached')`)));

  // clicking again detaches (removes the image)
  await evalJs(`document.getElementById('file-attach-tag').click()`);
  await wait(300);
  check("click again detaches", !!(await evalJs(`window.__attachments.length === 0`)));

  // close the web tab
  await evalJs(`(() => {
    const tab = Array.from(document.querySelectorAll('#file-tabs .ftab')).find(t => t.classList.contains('ftab-web'));
    tab.querySelector('.fclose').click();
  })()`);
  await wait(200);
  check("web tab closes", !!(await evalJs(`!Array.from(document.querySelectorAll('#file-tabs .ftab')).some(t => t.classList.contains('ftab-web'))`)));

  cdp.close();
  await killApp(app);
  server.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
  console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: OK");
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await killApp(app); server.close(); process.exit(1); });
