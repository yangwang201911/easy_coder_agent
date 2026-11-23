// E2E: Settings > Remote server > ssh. An in-process ssh2 server (password "pw") fronts a real
// coder-agent-server on loopback. Drives the "user@host" window, a cancelled / wrong / right password,
// and the silent background reconnect (no password window after the tunnel drops).
// The host key is pre-trusted in known_hosts.json (the native trust dialog cannot be driven over CDP).
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const ssh2 = require("ssh2");
const WebSocket = require("ws");
const { spawnApp, killApp, getWsUrl, connectCdp, wait, venvPython, killTree } = require("./cdp_test_lib.cjs");

const PASSWORD = "pw";
const TOKEN = "tok-e2e";
const SERVER_PORT = 8940 + Math.floor(Math.random() * 40);
let failed = false;
const check = (label, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) failed = true; };

const listTargets = (port) => new Promise((resolve) => {
  http.get(`http://127.0.0.1:${port}/json`, (res) => {
    let b = ""; res.on("data", (d) => { b += d; }); res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve([]); } });
  }).on("error", () => resolve([]));
});
async function waitTarget(port, title, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = (await listTargets(port)).find((x) => x.type === "page" && x.title === title);
    if (t) { const c = connectCdp(t.webSocketDebuggerUrl); await c.opened; await wait(400); return c; }
    await wait(200);
  }
  return null;
}
async function noTarget(port, title, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await listTargets(port)).some((x) => x.title === title)) return false;
    await wait(250);
  }
  return true;
}

(async () => {
  // real agent server, loopback only, with a token
  const srv = spawn(venvPython(), ["-m", "coder_agent.server", "--host", "127.0.0.1", "--port", String(SERVER_PORT), "--token", TOKEN],
    { cwd: path.join(__dirname, "..", "backend"), stdio: ["ignore", "pipe", "pipe"], detached: true });
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("server did not start")), 30000);
    srv.stdout.on("data", (d) => { if (String(d).includes("WS_URL=")) { clearTimeout(t); res(); } }); });

  // in-process sshd with direct-tcpip forwarding
  const hostKeys = ssh2.utils.generateKeyPairSync("ed25519");
  const conns = [];
  const sshd = new ssh2.Server({ hostKeys: [hostKeys.private] }, (client) => {
    conns.push(client);
    client.on("authentication", (ctx) => (ctx.method === "password" && ctx.password === PASSWORD ? ctx.accept() : ctx.reject(["password"])));
    client.on("error", () => {});
    client.on("ready", () => client.on("tcpip", (accept, _r, info) => {
      const stream = accept(); const sock = net.connect(info.destPort, info.destIP);
      stream.pipe(sock).pipe(stream); sock.on("error", () => stream.end()); stream.on("error", () => sock.destroy());
    }));
  });
  await new Promise((r) => sshd.listen(0, "127.0.0.1", r));
  const sshPort = sshd.address().port;
  const blob = ssh2.utils.parseKey(hostKeys.public).getPublicSSH();
  const fp = "SHA256:" + crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cdp-ssh-"));
  fs.writeFileSync(path.join(userData, "known_hosts.json"), JSON.stringify({ [`127.0.0.1:${sshPort}`]: fp }));
  const app = spawnApp({ root: path.resolve(__dirname, ".."), userDataDir: userData });

  try {
    const url = await getWsUrl(app.port);
    const cdp = connectCdp(url); await cdp.opened;
    const ev = cdp.evalJs;
    for (let i = 0; i < 120; i++) {
      if (String(await ev("document.getElementById('titlebar-name') && document.getElementById('titlebar-name').textContent")).includes("Coder Agent:")) break;
      await wait(250);
    }
    const openConn = async () => {
      await ev("document.getElementById('rail-settings').click()"); await wait(400);
      await ev("[...document.querySelectorAll('#modal .tabs button')].find(b => b.dataset.p === 'connection').click()"); await wait(400);
    };
    const apply = (mode) => ev(`(() => { const m = document.querySelector('#modal .c-mode'); m.value = '${mode}'; m.dispatchEvent(new Event('change'));
      document.querySelector('#modal .c-token').value = '${TOKEN}'; document.querySelector('#modal .c-apply').click(); })()`);
    const msg = () => ev("(document.querySelector('#modal .page[data-p=\"connection\"] .msg') || {}).textContent || ''");
    const fillTarget = async (win) => {
      await ev("0"); // keep alignment with cdp calls
      await win.evalJs(`(() => { const i = document.querySelectorAll('input'); i[0].value = 'u@127.0.0.1:${sshPort}'; i[1].value = '${SERVER_PORT}'; document.querySelector('button.ok').click(); })()`);
    };

    await openConn();
    check("ssh group shows the single summary line (no host/user/port fields)",
      await ev("!document.querySelector('#modal .c-ssh-host') && !!document.querySelector('#modal .c-ssh-summary')"));

    // A) cancel at the password window
    await apply("ssh");
    let w = await waitTarget(app.port, "Connect via SSH");
    check("Apply opens the user@host window", !!w);
    check("target window has a single visible target field", (await w.evalJs("document.querySelectorAll('input').length")) === 3 && (await w.evalJs("document.querySelectorAll('details').length")) === 1);
    await fillTarget(w); w.close();
    w = await waitTarget(app.port, "SSH login");
    check("password window follows", !!w && (await w.evalJs("document.querySelector('input').type")) === "password");
    await w.evalJs("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))"); w.close();
    await wait(1200);
    check("cancel is reported in Settings", /cancelled/i.test(await msg()));

    // B) wrong password -> error line -> right password
    await apply("ssh");
    w = await waitTarget(app.port, "Connect via SSH");
    check("target window is prefilled from the saved target", !!w && (await w.evalJs("document.querySelector('input').value")) === `u@127.0.0.1:${sshPort}`);
    await w.evalJs("document.querySelector('button.ok').click()"); w.close();
    w = await waitTarget(app.port, "SSH login");
    await w.evalJs(`(() => { document.querySelector('input').value = 'wrong'; document.querySelector('button.ok').click(); })()`); w.close();
    w = await waitTarget(app.port, "SSH login");
    check("wrong password asks again with an error", !!w && /permission denied/i.test(await w.evalJs("(document.querySelector('.err') || {}).textContent || ''")));
    await w.evalJs(`(() => { document.querySelector('input').value = '${PASSWORD}'; document.querySelector('button.ok').click(); })()`); w.close();
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) { ok = /Connected to ws:\/\/127\.0\.0\.1/.test(await msg()) || !(await ev("!!document.querySelector('#modal .c-apply')")); await wait(250); }
    check("connected through the tunnel", ok);
    await wait(800);
    check("connection chip shows the ssh target", String(await ev("document.getElementById('conn-mode-text').textContent")).includes("SSH u@127.0.0.1"));

    // C) RPC through ssh tunnel to the real server (token handshake included)
    const reply = await ev(`new Promise((res) => { window.api.onReply((m) => { if (m.id === 777) res(JSON.stringify(m).slice(0, 200)); });
      window.api.send({ id: 777, method: 'default_config', params: {} }); setTimeout(() => res('timeout'), 8000); })`, 12000);
    check("RPC answered through the ssh tunnel", typeof reply === "string" && reply !== "timeout" && !/error/.test(reply));

    // D) drop the ssh connection: reconnect happens silently with the cached password
    const before = conns.length;
    conns.forEach((c) => c.end());
    let reconnected = false;
    for (let i = 0; i < 80 && !reconnected; i++) { reconnected = conns.length > before; await wait(250); }
    check("tunnel re-established in the background", reconnected);
    check("no password window during the background reconnect", await noTarget(app.port, "SSH login", 3000));
    const reply2 = await ev(`new Promise((res) => { window.api.onReply((m) => { if (m.id === 778) res(JSON.stringify(m).slice(0, 200)); });
      window.api.send({ id: 778, method: 'default_config', params: {} }); setTimeout(() => res('timeout'), 10000); })`, 14000);
    check("RPC works again after the reconnect", typeof reply2 === "string" && reply2 !== "timeout" && !/error/.test(reply2));
    cdp.close();
  } catch (e) {
    console.log("FAIL  exception: " + (e && e.stack || e)); failed = true;
  } finally {
    await killApp(app);
    killTree(srv.pid); sshd.close(); conns.forEach((c) => c.end());
  }
  console.log(failed ? "FAILED" : "ALL OK");
  process.exit(failed ? 1 : 0);
})();
