// Pure-node tests for src/main/ssh-tunnel.ts against an in-process ssh2 server (no electron, no real ssh).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ssh2 = require("ssh2");
const { buildSync } = require("esbuild");

// built next to the sources so require("ssh2") resolves from gui/node_modules
const outDir = fs.mkdtempSync(path.join(__dirname, ".ssh-tunnel-test-"));
process.on("exit", () => fs.rmSync(outDir, { recursive: true, force: true }));
const out = path.join(outDir, "ssh-tunnel.cjs");
buildSync({ entryPoints: [path.join(__dirname, "..", "..", "src/main/ssh-tunnel.ts")], bundle: true, platform: "node",
  format: "cjs", external: ["ssh2"], outfile: out, logLevel: "error" });
const { openTunnel, parseSshTarget, SshInteractionRequired } = require(out);

const PASSWORD = "right-pw";

async function startEnv() {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const hostKey = ssh2.utils.generateKeyPairSync("ed25519").private;
  const conns = [];
  const sshd = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    conns.push(client);
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.password === PASSWORD) ctx.accept();
      else ctx.reject(["password"]);
    });
    client.on("error", () => {});
    client.on("ready", () => {
      client.on("tcpip", (accept, _rej, info) => {
        const stream = accept();
        const sock = net.connect(info.destPort, info.destIP);
        stream.pipe(sock).pipe(stream);
        sock.on("error", () => stream.end());
      });
    });
  });
  await new Promise((r) => sshd.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-env-"));
  return {
    target: { host: "127.0.0.1", user: "u", port: sshd.address().port, identity: "", remotePort: echo.address().port },
    knownHostsFile: path.join(dir, "known_hosts.json"),
    conns,
    async close() { conns.forEach((c) => c.end()); sshd.close(); echo.close(); },
  };
}

function hooks(answers, trust = true) {
  const h = { asked: [], trusted: [] };
  h.askPassword = async (target, error) => { h.asked.push({ target, error }); return answers.length ? answers.shift() : null; };
  h.confirmHostKey = async (hp, fp) => { h.trusted.push({ hp, fp }); return trust; };
  return h;
}

const echoThrough = (port) => new Promise((resolve, reject) => {
  const s = net.connect(port, "127.0.0.1", () => s.write("ping"));
  s.once("data", (d) => { s.destroy(); resolve(String(d)); });
  s.once("error", reject);
  setTimeout(() => reject(new Error("echo timeout")), 5000);
});

test("parseSshTarget", () => {
  assert.deepEqual(parseSshTarget("ywang2@10.112.106.102"), { user: "ywang2", host: "10.112.106.102", port: 22 });
  assert.deepEqual(parseSshTarget("  ssh://a@h.example:2222 "), { user: "a", host: "h.example", port: 2222 });
  assert.deepEqual(parseSshTarget("a@[::1]:2200"), { user: "a", host: "::1", port: 2200 });
  assert.deepEqual(parseSshTarget("a@::1"), { user: "a", host: "::1", port: 22 });
  for (const bad of ["host", "@host", "a@", "a@h:99999", "a b@h", ""]) assert.ok("error" in parseSshTarget(bad), bad);
});

test("password login: prompts once, trusts the host, forwards traffic, caches the password", async () => {
  const env = await startEnv();
  try {
    const h = hooks([PASSWORD]);
    const passwords = new Map();
    const tun = await openTunnel(env.target, h, { interactive: true, passwords, knownHostsFile: env.knownHostsFile });
    assert.equal(h.asked.length, 1);
    assert.equal(h.asked[0].target, "u@127.0.0.1");
    assert.equal(h.trusted.length, 1);
    assert.match(h.trusted[0].fp, /^SHA256:/);
    assert.equal(await echoThrough(tun.port), "ping");
    assert.equal(passwords.size, 1);
    assert.ok(Object.keys(JSON.parse(fs.readFileSync(env.knownHostsFile, "utf8"))).length === 1);
    tun.close();
  } finally { await env.close(); }
});

test("wrong password is re-asked with an error, then accepted; the bad one is not cached", async () => {
  const env = await startEnv();
  try {
    const h = hooks(["nope", PASSWORD]);
    const passwords = new Map();
    const tun = await openTunnel(env.target, h, { interactive: true, passwords, knownHostsFile: env.knownHostsFile });
    assert.equal(h.asked.length, 2);
    assert.equal(h.asked[0].error, "");
    assert.match(h.asked[1].error, /permission denied/i);
    assert.deepEqual([...passwords.values()], [PASSWORD]);
    tun.close();
  } finally { await env.close(); }
});

test("three wrong passwords fail without an endless loop", async () => {
  const env = await startEnv();
  try {
    const h = hooks(["a", "b", "c", "d"]);
    const passwords = new Map();
    await assert.rejects(openTunnel(env.target, h, { interactive: true, passwords, knownHostsFile: env.knownHostsFile }),
      /permission denied/i);
    assert.equal(h.asked.length, 3);
    assert.equal(passwords.size, 0);
  } finally { await env.close(); }
});

test("cancelling the password prompt fails cleanly", async () => {
  const env = await startEnv();
  try {
    const h = hooks([]);
    await assert.rejects(openTunnel(env.target, h, { interactive: true, passwords: new Map(), knownHostsFile: env.knownHostsFile }),
      /cancelled/i);
    assert.equal(h.asked.length, 1);
  } finally { await env.close(); }
});

test("background reconnect: uses the cached password, never prompts, and refuses to prompt when none is cached", async () => {
  const env = await startEnv();
  try {
    const first = hooks([PASSWORD]);
    const passwords = new Map();
    (await openTunnel(env.target, first, { interactive: true, passwords, knownHostsFile: env.knownHostsFile })).close();
    const bg = hooks([]);
    const tun = await openTunnel(env.target, bg, { interactive: false, passwords, knownHostsFile: env.knownHostsFile });
    assert.equal(bg.asked.length, 0);
    assert.equal(await echoThrough(tun.port), "ping");
    tun.close();
    const none = hooks([]);
    await assert.rejects(openTunnel(env.target, none, { interactive: false, passwords: new Map(), knownHostsFile: env.knownHostsFile }),
      (e) => e instanceof SshInteractionRequired);
    assert.equal(none.asked.length, 0);
  } finally { await env.close(); }
});

test("unknown host key: not trusted by the user -> no login attempt; background -> interaction required", async () => {
  const env = await startEnv();
  try {
    const h = hooks([PASSWORD], false);
    await assert.rejects(openTunnel(env.target, h, { interactive: true, passwords: new Map(), knownHostsFile: env.knownHostsFile }),
      /not trusted/i);
    assert.equal(h.asked.length, 0);
    const bg = hooks([PASSWORD]);
    await assert.rejects(openTunnel(env.target, bg, { interactive: false, passwords: new Map([["u@127.0.0.1:" + env.target.port, PASSWORD]]), knownHostsFile: env.knownHostsFile }),
      (e) => e instanceof SshInteractionRequired);
  } finally { await env.close(); }
});

test("changed host key is refused", async () => {
  const env = await startEnv();
  try {
    fs.writeFileSync(env.knownHostsFile, JSON.stringify({ [`127.0.0.1:${env.target.port}`]: "SHA256:someOtherKey" }));
    const h = hooks([PASSWORD]);
    await assert.rejects(openTunnel(env.target, h, { interactive: true, passwords: new Map(), knownHostsFile: env.knownHostsFile }),
      /HOST KEY CHANGED/);
    assert.equal(h.asked.length, 0);
    assert.equal(h.trusted.length, 0);
  } finally { await env.close(); }
});

test("onClose fires when the server drops an established tunnel, not after close()", async () => {
  const env = await startEnv();
  try {
    let closed = 0;
    const tun = await openTunnel(env.target, hooks([PASSWORD]), { interactive: true, passwords: new Map(),
      knownHostsFile: env.knownHostsFile, onClose: () => { closed++; } });
    env.conns.forEach((c) => c.end());
    for (let i = 0; i < 50 && !closed; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(closed, 1);
    tun.close();
    const env2 = await startEnv();
    let closed2 = 0;
    const t2 = await openTunnel(env2.target, hooks([PASSWORD]), { interactive: true, passwords: new Map(),
      knownHostsFile: env2.knownHostsFile, onClose: () => { closed2++; } });
    t2.close();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(closed2, 0);
    await env2.close();
  } finally { await env.close(); }
});
