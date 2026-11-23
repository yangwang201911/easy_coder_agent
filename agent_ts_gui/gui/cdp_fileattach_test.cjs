// Smoke test: the "+name" attach tag above the input box appears once the
// active file's content has loaded, toggles to attached, and back.
const { spawnApp, killApp, getWsUrl, connectCdp, wait } = require("./cdp_test_lib.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fileattach-test-"));
fs.writeFileSync(path.join(testRoot, "manage_ollma_mtp.sh"), "#!/bin/bash\necho hi\n");

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

  // open the file from the tree
  await evalJs(`document.querySelector('#left-rail .tab[data-tab="files"]').click()`);
  await wait(300);
  await evalJs(`Array.from(document.querySelectorAll('#file-tree .tree-row')).find(e => e.textContent.includes('manage_ollma_mtp.sh')).click()`);

  // the tag must appear above the input box once the content is loaded
  let shown = false;
  for (let i = 0; i < 20; i++) {
    shown = !!(await evalJs(`(() => {
      const t = document.getElementById('file-attach-tag');
      return t && !t.classList.contains('hidden') && t.textContent.includes('manage_ollma_mtp.sh');
    })()`));
    if (shown) break;
    await wait(300);
  }
  check("attach tag appears after file loads", shown,
    await evalJs(`document.getElementById('file-attach-tag').className + " | " + document.getElementById('file-attach-tag').textContent`));

  // click it -> attached state
  await evalJs(`document.getElementById('file-attach-tag').click()`);
  await wait(200);
  check("click attaches", !!(await evalJs(`document.getElementById('file-attach-tag').classList.contains('attached')`)));

  // click again -> detached
  await evalJs(`document.getElementById('file-attach-tag').click()`);
  await wait(200);
  check("click again detaches", !!(await evalJs(`!document.getElementById('file-attach-tag').classList.contains('attached')`)));

  cdp.close();
  await killApp(app);
  fs.rmSync(testRoot, { recursive: true, force: true });
  console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: OK");
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await killApp(app); process.exit(1); });
