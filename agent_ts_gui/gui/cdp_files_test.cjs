// Smoke test for the Files tree + tabbed file viewer (left "Files" tab, mid file tabs).
const { spawnApp, killApp, getWsUrl, connectCdp, wait } = require("./cdp_test_lib.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");

// a scratch project with one file, plus a pre-seeded session whose turn t1
// modified src/mod.txt (snapshot of the original content stored in .agent)
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-files-test-"));
fs.mkdirSync(path.join(testRoot, "src"), { recursive: true });
fs.writeFileSync(path.join(testRoot, "src", "hello.txt"), "line1\nline2\nline3\n");
fs.writeFileSync(path.join(testRoot, "src", "mod.txt"), "changed line\n");
fs.writeFileSync(path.join(testRoot, "plain.txt"), "untouched\n");
const sid = "20260101-000000-test01";
const cache = path.join(testRoot, ".agent");
fs.mkdirSync(path.join(cache, "sessions"), { recursive: true });
fs.mkdirSync(path.join(cache, "snapshots", sid, "t1", "blobs"), { recursive: true });
fs.writeFileSync(path.join(cache, "snapshots", sid, "t1", "blobs", "blob1"), "old line\n");
fs.writeFileSync(path.join(cache, "snapshots", sid, "t1", "manifest.json"),
  JSON.stringify({ files: { "src/mod.txt": { existed: true, blob: "blob1" } } }));
fs.writeFileSync(path.join(cache, "sessions", sid + ".json"), JSON.stringify({
  id: sid, head: "t1",
  turns: [{ id: "t1", parent_id: null, prompt: "seed turn", task_type: "general",
    messages: [], base_messages: null, archive: [], files_changed: ["src/mod.txt"],
    ran_commands: false, status: "done", final_text: "", subtasks: [], created: 1 }],
}));

const app = spawnApp({ root: testRoot });
const backendLog = () => app.getLog();

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

  // wait for the project to open (tree loaded)
  let opened = false;
  for (let i = 0; i < 120; i++) {
    opened = !!(await evalJs(`document.querySelector('#file-tree .tree-row') ? true : false`));
    if (opened) break;
    await wait(500);
  }
  check("project opened, tree has rows", opened);

  // 1) Files tab exists in the left tabs
  check("left Files tab exists", !!(await evalJs(`!!document.querySelector('#left-rail .tab[data-tab="files"]')`)));

  // 1b) open the seeded session (the boot session is fresh, the seeded one holds the turn)
  await evalJs(`document.querySelector('#left-rail .tab[data-tab="sessions"]').click()`);
  let seeded = false;
  for (let i = 0; i < 40; i++) {
    seeded = !!(await evalJs(`(() => {
      const li = Array.from(document.querySelectorAll('#session-list li')).find(e => e.textContent.includes('seed turn'));
      if (!li) return false;
      li.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    })()`));
    if (seeded) break;
    await wait(500);
  }
  check("seeded session opened", seeded);
  await wait(800);

  // 2) switch to the Files tab and verify the tree shows src/
  await evalJs(`document.querySelector('#left-rail .tab[data-tab="files"]').click()`);
  await wait(300);
  const treeNames = await evalJs(`Array.from(document.querySelectorAll('#file-tree .tree-row')).map(e => e.textContent)`);
  check("tree shows src dir", (treeNames ?? []).some((n) => n.includes("src")), JSON.stringify(treeNames));

  // 2b) src/ contains a changed file: it must be auto-expanded (arrow ▾, children visible)
  let autoOpen = false;
  for (let i = 0; i < 20; i++) {
    autoOpen = !!(await evalJs(`(() => {
      const row = Array.from(document.querySelectorAll('#file-tree .tree-row.dir')).find(e => e.textContent.includes('src'));
      if (!row) return false;
      const child = row.nextElementSibling;
      return row.querySelector('.tree-arrow').textContent === '▾'
        && child && !child.classList.contains('hidden')
        && child.textContent.includes('mod.txt');
    })()`));
    if (autoOpen) break;
    await wait(300);
  }
  check("dir with changes is auto-expanded", autoOpen);
  check("changed file has changed style + icon", !!(await evalJs(`(() => {
      const row = Array.from(document.querySelectorAll('#file-tree .tree-row')).find(e => e.textContent.includes('mod.txt'));
      return row && row.classList.contains('changed') && row.querySelector('.tree-ico').textContent === '✎';
    })()`)));
  check("unchanged file has plain icon", !!(await evalJs(`(() => {
      const row = Array.from(document.querySelectorAll('#file-tree .tree-row')).find(e => e.textContent.includes('hello.txt'));
      return row && !row.classList.contains('changed') && row.querySelector('.tree-ico').textContent === '📄';
    })()`)));

  // 3) expand a plain dir (hello.txt already visible via auto-expand; toggle it closed and open)
  await evalJs(`document.querySelector('#file-tree .tree-row.dir').click()`); // collapse
  await wait(200);
  await evalJs(`document.querySelector('#file-tree .tree-row.dir').click()`); // re-expand
  let fileRow = false;
  for (let i = 0; i < 20; i++) {
    fileRow = !!(await evalJs(`Array.from(document.querySelectorAll('#file-tree .tree-row')).find(e => e.textContent.includes('hello.txt'))`));
    if (fileRow) break;
    await wait(300);
  }
  check("collapsing/expanding src keeps working", fileRow);

  // 4) click the unchanged file -> a tab opens and the mid pane shows its content
  await evalJs(`Array.from(document.querySelectorAll('#file-tree .tree-row')).find(e => e.textContent.includes('hello.txt')).click()`);
  let bodyText = "";
  for (let i = 0; i < 20; i++) {
    bodyText = await evalJs(`document.getElementById('file-body').textContent`) ?? "";
    if (!bodyText.includes("loading...") && bodyText.includes("line2")) break;
    await wait(300);
  }
  check("mid shows file content", bodyText.includes("line2"), bodyText.slice(0, 80));
  check("tab bar has one tab", (await evalJs(`document.querySelectorAll('#file-tabs .ftab').length`)) === 1);
  check("tab is active and named", !!(await evalJs(`(() => {
      const t = document.querySelector('#file-tabs .ftab');
      return t && t.classList.contains('active') && t.querySelector('.fname').textContent === 'hello.txt';
    })()`)));

  // 4b) click the changed file -> second tab, both tabs present, content switched
  await evalJs(`Array.from(document.querySelectorAll('#file-tree .tree-row')).find(e => e.textContent.includes('mod.txt')).click()`);
  let modOk = false;
  for (let i = 0; i < 20; i++) {
    modOk = !!(await evalJs(`(() => {
      const body = document.getElementById('file-body');
      const tabs = document.querySelectorAll('#file-tabs .ftab');
      return body.textContent.includes('changed line') && tabs.length === 2
        && tabs[1].classList.contains('active');
    })()`));
    if (modOk) break;
    await wait(300);
  }
  check("second tab opens with its content", modOk);
  check("changed tab shows modified dot", !!(await evalJs(`(() => {
      const t = Array.from(document.querySelectorAll('#file-tabs .ftab')).find(e => e.querySelector('.fname').textContent === 'mod.txt');
      return t && t.querySelector('.fdot');
    })()`)));
  check("unchanged tab has no dot", !!(await evalJs(`(() => {
      const t = Array.from(document.querySelectorAll('#file-tabs .ftab')).find(e => e.querySelector('.fname').textContent === 'hello.txt');
      return t && !t.querySelector('.fdot');
    })()`)));

  // 5) click the first tab -> switches back to hello.txt content
  await evalJs(`Array.from(document.querySelectorAll('#file-tabs .ftab')).find(e => e.querySelector('.fname').textContent === 'hello.txt').click()`);
  await wait(200);
  let switched = false;
  for (let i = 0; i < 20; i++) {
    switched = !!(await evalJs(`(() => {
      const body = document.getElementById('file-body');
      const tabs = document.querySelectorAll('#file-tabs .ftab');
      return body.textContent.includes('line2') && !body.textContent.includes('changed line')
        && tabs[0].classList.contains('active') && !tabs[1].classList.contains('active');
    })()`));
    if (switched) break;
    await wait(300);
  }
  check("clicking a tab switches the view", switched);

  // 5b) close the active tab -> the other tab becomes active
  await evalJs(`Array.from(document.querySelectorAll('#file-tabs .ftab')).find(e => e.querySelector('.fname').textContent === 'hello.txt').querySelector('.fclose').click()`);
  await wait(200);
  let closed = false;
  for (let i = 0; i < 20; i++) {
    closed = !!(await evalJs(`(() => {
      const tabs = document.querySelectorAll('#file-tabs .ftab');
      const body = document.getElementById('file-body');
      return tabs.length === 1 && tabs[0].classList.contains('active')
        && tabs[0].querySelector('.fname').textContent === 'mod.txt'
        && body.textContent.includes('changed line');
    })()`));
    if (closed) break;
    await wait(300);
  }
  check("close button removes the tab and switches to the remaining one", closed);

  // 6) tree refresh button does not break
  await evalJs(`document.getElementById('tree-refresh-btn').click()`);
  await wait(500);
  check("tree refresh keeps rows", !!(await evalJs(`document.querySelectorAll('#file-tree .tree-row').length > 0`)));

  cdp.close();
  await killApp(app);
  fs.rmSync(testRoot, { recursive: true, force: true });
  console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: OK");
  process.exit(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await killApp(app); process.exit(1); });
