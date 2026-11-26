// Smoke test for image attachments: paste/drop/pick -> thumbnail strip ->
// sent with the submit RPC as image_url data URLs.
const { spawnApp, killApp, getWsUrl, connectCdp, wait } = require("./cdp_test_lib.cjs");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-image-test-"));
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
  check("attach strip exists", !!(await evalJs(`!!document.getElementById('attach-strip')`)));
  check("image button exists", !!(await evalJs(`!!document.getElementById('image-btn')`)));

  // 2) add an attachment via the CDP hook -> thumbnail appears
  await evalJs(`window.__addImageAttachment('shot.png', 'data:image/png;base64,QUJD')`);
  await wait(200);
  check("thumbnail rendered", (await evalJs(`document.querySelectorAll('#attach-strip .attach-item').length`)) === 1);
  check("strip visible", !(await evalJs(`document.getElementById('attach-strip').classList.contains('hidden')`)));

  // 3) a second attachment, then remove the first
  await evalJs(`window.__addImageAttachment('b.png', 'data:image/png;base64,REVG')`);
  await wait(100);
  check("two thumbnails", (await evalJs(`document.querySelectorAll('#attach-strip .attach-item').length`)) === 2);
  await evalJs(`document.querySelector('#attach-strip .attach-x').click()`);
  await wait(100);
  check("one left after remove", (await evalJs(`document.querySelectorAll('#attach-strip .attach-item').length`)) === 1);
  check("remaining is b.png", (await evalJs(`window.__attachments[0] && window.__attachments[0].name`)) === "b.png");

  // 4) the limit is enforced
  await evalJs(`for (let i = 0; i < 10; i++) window.__addImageAttachment('x' + i + '.png', 'data:image/png;base64,QUJD')`);
  await wait(100);
  check("capped at 5", (await evalJs(`window.__attachments.length`)) === 5);

  // 5) send: the turn must reach the backend with the images. Verify via the
  //    session JSON the backend persists (full GUI -> server -> engine path).
  await evalJs(`
    document.getElementById('input').value = 'describe this';
    document.getElementById('send-btn').click();
    true`);
  const sessDir = path.join(testRoot, ".agent", "sessions");
  let turn = null;
  for (let i = 0; i < 150; i++) {
    await wait(400);
    try {
      const files = fs.readdirSync(sessDir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        const data = JSON.parse(fs.readFileSync(path.join(sessDir, f), "utf8"));
        const t = (data.turns || []).find((x) => x.prompt === "describe this");
        if (t) { turn = t; break; }
      }
      if (turn) break;
    } catch { /* session not written yet */ }
  }
  check("turn persisted", !!turn);
  check("image names persisted", turn && Array.isArray(turn.images) && turn.images.length === 5 && turn.images[0] === "b.png");
  const userMsg = turn && turn.messages && turn.messages[0];
  check("user msg multimodal", !!userMsg && Array.isArray(userMsg.content) && userMsg.content.some((p) => p.type === "image_url"));
  check("data url shape", !!userMsg && userMsg.content.some((p) => p.type === "image_url" && String(p.image_url.url).startsWith("data:image/")));
  check("strip cleared after send", (await evalJs(`document.querySelectorAll('#attach-strip .attach-item').length`)) === 0);

  // 6) paste path: an image in the clipboard becomes an attachment
  await evalJs(`
    (async () => {
      const img = new Image();
      img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      await img.decode();
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      c.getContext('2d').drawImage(img, 0, 0);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'paste.png', { type: 'image/png' }));
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      document.getElementById('input').dispatchEvent(ev);
      return true;
    })()`);
  await wait(400);
  check("pasted image attached", (await evalJs(`window.__attachments.length`)) === 1);
  check("pasted name kept", (await evalJs(`window.__attachments[0] && window.__attachments[0].name`)) === "paste.png");

  await killApp(app);
  console.log(failed ? "\nIMAGE TEST FAILED" : "\nimage test ok");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("test error:", e);
  killApp(app).finally(() => process.exit(1));
});
