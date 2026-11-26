// Electron main process: owns the window, the Python backend subprocess and the
// WebSocket bridge to the backend.
import { app, BrowserWindow, ipcMain, dialog, Menu } from "electron";
import { spawn, ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import WebSocket from "ws";
import { backendUrlFromLine } from "./backend-output";
import { openTunnel, SshInteractionRequired, Tunnel } from "./ssh-tunnel";
import { showPrompt } from "./prompt-window";

// Backend location: in dev the repo's backend/ dir + its venv python; in a
// packaged app a standalone PyInstaller bundle shipped in resources/backend.
function backendInfo(): { cmd: string; args: string[]; cwd: string } {
  if (app.isPackaged) {
    const dir = path.join(process.resourcesPath, "backend");
    const exe = process.platform === "win32" ? "coder-agent-server.exe" : "coder-agent-server";
    return { cmd: path.join(dir, exe), args: [], cwd: dir };
  }
  const dir = path.resolve(__dirname, "../..");
  const venv = process.platform === "win32"
    ? path.join(dir, ".venv", "Scripts", "python.exe")
    : path.join(dir, ".venv", "bin", "python");
  const py = fs.existsSync(venv) ? venv : (process.platform === "win32" ? "python" : "python3");
  return { cmd: py, args: ["-m", "coder_agent.server"], cwd: dir };
}

let quitting = false; // set by killBackend(); blocks new backend spawns during shutdown
let backend: ChildProcess | null = null;
let backendUrl: string | null = null;
let backendRoot: string | null = null;
let window: BrowserWindow | null = null;
let ws: WebSocket | null = null;
let wsReady: Promise<void> = Promise.resolve(); // resolves when the current socket is open
let backendUp = false; // true once a connection is established; false while (re)connecting / down
let connecting = false; // true while a connectWs() is in flight (RPCs should queue)
let reconnecting = false; // suppress "backend-exit" while switching connections
let remoteReconnect = false; // auto-reconnect is active for the current remote connection
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelay = 1000; // ms, grows x2 up to 15s
let tunnel: Tunnel | null = null; // ssh tunnel (ssh mode only)
let tunnelPort = 0; // local port the tunnel forwards to the remote server
let lastConnError = ""; // last connection problem, shown by the renderer (it may not be loaded yet when it happens)
const rememberedPasswords = new Map<string, string>(); // session cache (per target), filled only after a successful login

// ------------------------------------------------------------- connection
// mode "local"  = spawn the bundled backend on this machine (default, as before).
// mode "remote" = connect to a coder-agent-server running on another machine
// (or on this machine, started separately). One server serves one GUI.
// mode "ssh"    = like remote, but the GUI opens an ssh tunnel
// (ssh -N -L localPort:127.0.0.1:remotePort user@host) and connects to the
// local port; the server only needs to listen on loopback on the remote box.
interface SshTarget { host: string; user: string; port: number; identity: string; remotePort: number; }
interface SshHost extends SshTarget { name: string; }
interface Connection { mode: "local" | "remote" | "ssh"; host: string; port: number; token: string; ssh?: SshTarget; }
const DEFAULT_CONN: Connection = { mode: "local", host: "127.0.0.1", port: 8931, token: "" };
let conn: Connection = { ...DEFAULT_CONN };
// Named SSH hosts managed in Settings > Remote server; conn.ssh is the currently
// selected one (used at startup / for Apply & reconnect).
let sshHosts: SshHost[] = [];

function connFile(): string {
  return path.join(app.getPath("userData"), "connection.json");
}
function normSshHost(h: any): SshHost | null {
  if (!h || typeof h !== "object") return null;
  const host = String(h.host || ""), user = String(h.user || "");
  if (!host || !user) return null;
  return { name: String(h.name || `${user}@${host}`), host, user,
    port: Number(h.port) || 22, identity: String(h.identity || ""),
    remotePort: Number(h.remotePort) || 8931 };
}
function loadConn(): Connection {
  try {
    if (fs.existsSync(connFile())) {
      const c = JSON.parse(fs.readFileSync(connFile(), "utf8"));
      const mode = c.mode === "remote" ? "remote" : c.mode === "ssh" ? "ssh" : "local";
      const conn: Connection = { mode,
        host: String(c.host || "127.0.0.1"), port: Number(c.port) || 8931, token: String(c.token || "") };
      if (mode === "ssh" && c.ssh) {
        conn.ssh = { host: String(c.ssh.host || ""), user: String(c.ssh.user || ""),
          port: Number(c.ssh.port) || 22, identity: String(c.ssh.identity || ""),
          remotePort: Number(c.ssh.remotePort) || 8931 };
      }
      // named host list (new format); migrate the old single conn.ssh into it
      sshHosts = Array.isArray(c.ssh_hosts)
        ? c.ssh_hosts.map(normSshHost).filter((h): h is SshHost => !!h)
        : [];
      if (mode === "ssh" && conn.ssh && !sshHosts.some((h) =>
          h.host === conn.ssh!.host && h.user === conn.ssh!.user && h.port === conn.ssh!.port)) {
        sshHosts.push({ name: `${conn.ssh.user}@${conn.ssh.host}`, ...conn.ssh });
      }
      return conn;
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONN };
}
function saveConn(c: Connection) {
  conn = c;
  try { fs.writeFileSync(connFile(), JSON.stringify({ ...c, ssh_hosts: sshHosts }, null, 2)); } catch { /* ignore */ }
}
function saveSshHosts(hosts: SshHost[], activeName?: string | null) {
  sshHosts = hosts;
  // keep conn.ssh pointing at the selected host (only meaningful in ssh mode)
  if (conn.mode === "ssh" && activeName) {
    const h = sshHosts.find((x) => x.name === activeName);
    if (h) conn = { ...conn, ssh: { host: h.host, user: h.user, port: h.port, identity: h.identity, remotePort: h.remotePort } };
  }
  try { fs.writeFileSync(connFile(), JSON.stringify({ ...conn, ssh_hosts: sshHosts }, null, 2)); } catch { /* ignore */ }
}

// ------------------------------------------------------------- backend proc
function startBackend(root: string | null): Promise<string> {
  const bi = backendInfo();
  const args = [...bi.args];
  if (root) args.push("--root", root);
  console.log("[main] starting backend:", bi.cmd, "root =", root);
  return new Promise((resolve, reject) => {
    const proc = spawn(bi.cmd, args, { cwd: bi.cwd, stdio: ["pipe", "pipe", "pipe"] });
    backend = proc;
    if (quitting) {
      // the app is shutting down (window closed while a restart was in flight):
      // never let this process outlive the app, or before-quit blocks forever
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      proc.once("exit", () => reject(new Error("app is quitting")));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error("backend did not start within 30s")); }
    }, 30000);
    const onLine = (line: string) => {
      const url = backendUrlFromLine(line);
      if (url) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(url);
      } else process.stdout.write(`[backend] ${line}\n`);
    };
    let buf = "";
    proc.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    proc.stderr.on("data", (d: Buffer) => process.stderr.write(`[backend] ${d.toString()}`));
    proc.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`backend exited before it was ready (code=${code})`));
      }
      if (backend !== proc) return; // superseded by a restart / connection switch
      backend = null;
      closeWs();
      // while switching connections the old proc dying is expected: no banner
      if (reconnecting) { reconnecting = false; return; }
      if (window && !window.isDestroyed())
        window.webContents.send("backend-exit", code);
    });
    proc.on("error", (e) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    });
  });
}

// ------------------------------------------------------------- ssh tunnel
function knownHostsFile(): string {
  return path.join(app.getPath("userData"), "known_hosts.json");
}

function parentWindow(): BrowserWindow | null {
  return window && !window.isDestroyed() ? window : null;
}

function promptPassword(target: string, error: string): Promise<string | null> {
  return showPrompt(parentWindow(), {
    title: "SSH login",
    message: `Password for ${target}\nIt is kept in memory for this app session only.`,
    error,
    okLabel: "Connect",
    fields: [{ id: "password", label: "Password", type: "password" }],
  }).then((v) => (v ? v.password : null));
}

async function confirmHostKey(hostPort: string, fingerprint: string): Promise<boolean> {
  const opts = {
    type: "question" as const,
    title: "Unknown SSH host",
    message: `Trust ${hostPort}?`,
    detail: `The authenticity of this host cannot be verified.\nKey fingerprint: ${fingerprint}\n\nOnly continue if this is the machine you expect.`,
    buttons: ["Cancel", "Trust and continue"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const win = parentWindow();
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
}

function sendConnError(msg: string) {
  lastConnError = msg;
  console.error("[main] connection:", msg);
  if (window && !window.isDestroyed()) window.webContents.send("conn-error", msg);
}

// Opens the ssh tunnel and returns the local port. interactive=false (background reconnect)
// never opens a prompt: it throws SshInteractionRequired when the user is needed.
async function startTunnel(t: SshTarget, interactive = true): Promise<number> {
  stopTunnel();
  console.log(`[main] starting ssh tunnel: ${t.user}@${t.host}:${t.port || 22} -> remote port ${t.remotePort}`);
  let current: Tunnel | null = null;
  current = await openTunnel(t, { askPassword: promptPassword, confirmHostKey }, {
    interactive,
    passwords: rememberedPasswords,
    knownHostsFile: knownHostsFile(),
    onClose: () => {
      if (!current || tunnel !== current) return; // superseded by a new tunnel / switch
      tunnel = null;
      console.log("[main] ssh tunnel closed");
      // the socket dies with the tunnel; its close event (remoteReconnect) restarts tunnel + ws.
      // If the socket is already gone, trigger the reconnect here.
      if (remoteReconnect && !quitting) {
        if (ws) { try { ws.close(); } catch { /* ignore */ } }
        else if (window && !window.isDestroyed()) {
          window.webContents.send("backend-exit", null);
          scheduleReconnect(`ws://127.0.0.1:${tunnelPort}`, conn.token);
        }
      }
    },
  });
  tunnel = current;
  tunnelPort = current.port;
  console.log("[main] ssh tunnel up on 127.0.0.1:" + current.port);
  return current.port;
}

function stopTunnel() {
  if (tunnel) {
    const old = tunnel;
    tunnel = null;
    try { old.close(); } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------- ws bridge
function stopReconnect() {
  remoteReconnect = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectDelay = 1000;
}

function closeWs() {
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
}

function connectWs(url: string, token = ""): Promise<void> {
  closeWs();
  backendUp = false; // a new connection is in flight
  connecting = true;
  const socket = new WebSocket(url);
  ws = socket;
  // resolves once the socket is open, so callers can send RPCs immediately.
  // wsReady is what the ws-send IPC handler awaits: RPCs arriving while the
  // (re)connect is in flight must queue here instead of failing with
  // "backend not connected". It ALWAYS resolves (the handler then checks
  // backendUp), so a failed connect can never hang a queued RPC.
  let resolveReady: () => void;
  wsReady = new Promise<void>((res) => { resolveReady = res; });
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      console.log("[main] ws connected");
      // token handshake: must be the very first frame when the server requires one
      if (token) { try { socket.send(JSON.stringify({ token })); } catch { /* ignore */ } }
      backendUp = true;
      connecting = false;
      resolveReady();
      resolve();
    });
    socket.once("error", (e) => { connecting = false; resolveReady(); reject(e); });
  });
  opened.catch(() => { /* close follows */ });
  socket.on("message", (data) => {
    let msg: any;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (window && !window.isDestroyed()) {
      if (msg.event) window.webContents.send("agent-event", msg);
      else window.webContents.send("agent-reply", msg);
    }
  });
  socket.on("close", () => {
    // Only the socket that is still "current" triggers a reconnect. When we
    // deliberately closeWs() (switching connections / restarting), ws is already
    // null, so a replaced socket's close event must not start reconnecting.
    const isCurrent = ws === socket;
    if (isCurrent) { ws = null; backendUp = false; }
    if (isCurrent && remoteReconnect && !quitting) {
      if (window && !window.isDestroyed()) window.webContents.send("backend-exit", null);
      console.log(`[main] remote ws closed, retry in ${reconnectDelay}ms`);
      scheduleReconnect(url, token);
    }
  });
  socket.on("error", () => { /* close follows */ });
  return opened;
}

function scheduleReconnect(url: string, token: string) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!remoteReconnect || quitting) return;
    try {
      let u = url;
      if (conn.mode === "ssh" && conn.ssh) {
        // the tunnel died with (or before) the socket: bring up a fresh one
        const p = await startTunnel(conn.ssh, false);
        u = `ws://127.0.0.1:${p}`;
      }
      await connectWs(u, token);
      reconnectDelay = 1000;
      // the initial connect in createWindowAsync can fail and leave backendUrl
      // unset; without this the renderer's getBackendUrl() stays null forever
      // and queued projects (openProjectNamed) are never opened
      backendUrl = u;
      if (window && !window.isDestroyed()) window.webContents.send("backend-url", u);
    } catch (e) {
      if (e instanceof SshInteractionRequired) {
        // a password / host key is needed: stop retrying in the background, let the user reconnect explicitly
        remoteReconnect = false;
        sendConnError(`SSH session lost: ${e.message}. Open Settings > Remote server and press Apply & reconnect.`);
        if (window && !window.isDestroyed()) window.webContents.send("backend-exit", null);
        return;
      }
      console.log("[main] remote reconnect failed:", e);
      if (window && !window.isDestroyed()) window.webContents.send("backend-exit", null);
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      if (!quitting) scheduleReconnect(url, token);
    }
  }, reconnectDelay);
}

// ------------------------------------------------------------- last project
function lastProjectFile(): string {
  return path.join(app.getPath("userData"), "last-project.txt");
}

function lastProject(): string | null {
  if (conn.mode !== "local") return null; // the path lives on the server machine
  const p = lastProjectFile();
  if (fs.existsSync(p)) {
    const last = fs.readFileSync(p, "utf8").trim();
    if (last && fs.existsSync(last)) return last;
  }
  return null;
}

// App icon: in dev the repo's build-resources/icon-128.png; in a packaged app
// the same file shipped as resources/icon.png (see electron-builder extraResources).
function appIcon(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.resolve(__dirname, "../../build-resources/icon-128.png");
}

async function createWindowAsync(root: string | null) {
  window = new BrowserWindow({
    width: 1500,
    height: 900,
    title: "Coder Agent",
    icon: appIcon(),
    // frameless: the page draws its own title bar so it follows the app theme
    // (the native title bar follows the OS theme and cannot be themed on Linux)
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // load the page immediately: the window must not sit blank while the
  // Python backend starts (it takes a few seconds). The renderer shows a
  // "Starting backend..." state and waits for the "backend-url" event.
  window.loadFile(path.join(__dirname, "../renderer/index.html"));
  const startRoot = root ?? lastProject();
  let url: string;
  if (conn.mode === "remote" || conn.mode === "ssh") {
    if (conn.mode === "ssh") {
      if (!conn.ssh) {
        sendConnError("SSH mode is selected but no target is set. Open Settings > Remote server and press Apply & reconnect.");
        window.webContents.send("backend-exit", null);
        return;
      }
      try {
        const p = await startTunnel(conn.ssh);
        url = `ws://127.0.0.1:${p}`;
      } catch (e: any) {
        sendConnError(`SSH: ${e?.message ?? e}`);
        window.webContents.send("backend-exit", null);
        return;
      }
      console.log("[main] ssh mode, tunnel up, connecting to", url);
    } else {
      url = `ws://${conn.host}:${conn.port}`;
      console.log("[main] remote mode, connecting to", url);
    }
    remoteReconnect = true; // keep trying if the link drops later
    reconnectDelay = 1000;
    try {
      await connectWs(url, conn.token);
    } catch (e) {
      // first attempt failed: the banner is up, the auto-reconnect loop (armed
      // by the close event) will keep trying in the background
      console.error("[main] remote connect failed:", e);
      window.webContents.send("backend-exit", null);
      return;
    }
    backendUrl = url;
    backendRoot = startRoot;
    window.webContents.send("backend-url", url);
    return;
  }
  try {
    url = await startBackend(startRoot);
  } catch (e) {
    console.error("[main] backend startup failed:", e);
    window.webContents.send("backend-exit", null);
    return;
  }
  backendUrl = url;
  backendRoot = startRoot;
  console.log("[main] backend ready:", url);
  await connectWs(url).catch((e) => console.error("[main] ws connect failed:", e));
  window.webContents.send("backend-url", url);
}

app.whenReady().then(() => {
  // no native menu bar (File/Edit/View/...): the app is fully driven by the UI
  Menu.setApplicationMenu(null);
  conn = loadConn();
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  let root: string | null = null;
  const i = args.indexOf("--root");
  if (i >= 0 && args[i + 1]) root = args[i + 1];
  createWindowAsync(root);

  ipcMain.handle("win-minimize", () => window?.minimize());
  ipcMain.handle("win-toggle-maximize", () => {
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle("win-is-maximized", () => window?.isMaximized() ?? false);
  ipcMain.handle("win-close", () => window?.close());
  ipcMain.handle("backend-url", () => backendUrl);
  ipcMain.handle("backend-root", () => backendRoot);
  ipcMain.handle("app-version", () => app.getVersion());
  ipcMain.handle("ws-send", async (_e, payload: object) => {
    // queue RPCs that arrive while the (re)connect is in flight (boot,
    // restart, local<->remote switch) instead of failing immediately.
    // If the backend is down (and no connect/reconnect is in flight) fail fast.
    if (!connecting && !backendUp && !remoteReconnect) throw new Error("backend not connected");
    await wsReady;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("backend not connected");
    ws.send(JSON.stringify(payload));
  });
  ipcMain.handle("pick-directory", async () => {
    if (!window) return null;
    const r = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("pick-files", async () => {
    if (!window) return [];
    const r = await dialog.showOpenDialog(window, { properties: ["openFile", "multiSelections"] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle("pick-images", async () => {
    if (!window) return [];
    const r = await dialog.showOpenDialog(window, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    });
    if (r.canceled) return [];
    const out: { name: string; data_url: string }[] = [];
    for (const p of r.filePaths) {
      try {
        const buf = fs.readFileSync(p);
        const mime = p.toLowerCase().endsWith(".jpg") || p.toLowerCase().endsWith(".jpeg") ? "image/jpeg"
          : p.toLowerCase().endsWith(".png") ? "image/png"
          : p.toLowerCase().endsWith(".gif") ? "image/gif"
          : p.toLowerCase().endsWith(".webp") ? "image/webp" : "image/bmp";
        out.push({ name: p.slice(p.lastIndexOf("/") + 1), data_url: `data:${mime};base64,${buf.toString("base64")}` });
      } catch { /* unreadable file: skip */ }
    }
    return out;
  });
  // ------------------------------------------------- web page capture
  // A hidden BrowserWindow renders local web pages so the user can screenshot
  // them into the chat (capturePage cannot see into iframes of the main window).
  let captureWin: BrowserWindow | null = null;
  function captureWindow(): BrowserWindow {
    if (!captureWin || captureWin.isDestroyed()) {
      captureWin = new BrowserWindow({
        show: false,
        width: 1280,
        height: 900,
        webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: false },
      });
      captureWin.webContents.setAudioMuted(true);
      captureWin.on("closed", () => { captureWin = null; });
    }
    return captureWin;
  }
  ipcMain.handle("web-capture", async (_e, url: string): Promise<{ data_url?: string; error?: string }> => {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return { error: `only http(s) urls are supported, got '${u.protocol}'` };
    } catch (e: any) {
      return { error: `invalid url: ${e?.message ?? e}` };
    }
    const win = captureWindow();
    const done = new Promise<null>((res) => {
      const t = setTimeout(() => res(null), 15000);
      win.webContents.once("did-finish-load", () => { clearTimeout(t); res(null); });
      win.webContents.once("did-fail-load", (_e2, code, desc) => { clearTimeout(t); (win as any).__loadErr = `${desc} (${code})`; res(null); });
    });
    (win as any).__loadErr = null;
    win.loadURL(url).catch((e) => { (win as any).__loadErr = String(e?.message ?? e); });
    await done;
    const loadErr = (win as any).__loadErr as string | null;
    if (loadErr) return { error: `page failed to load: ${loadErr}` };
    await new Promise((r) => setTimeout(r, 400)); // let fonts / layout settle
    const shot = await win.webContents.capturePage();
    // downscale to keep the payload (and the model's token cost) small
    const maxEdge = 1568;
    const b = shot.getSize();
    const scale = Math.min(1, maxEdge / Math.max(b.width, b.height));
    const img = scale < 1 ? shot.resize({ width: Math.round(b.width * scale), height: Math.round(b.height * scale) }) : shot;
    return { data_url: `data:image/png;base64,${img.toPNG().toString("base64")}` };
  });
  ipcMain.handle("read-file", (_e, p: string): { content?: string; error?: string } => {
    try {
      const buf = fs.readFileSync(p);
      if (buf.includes(0)) return { error: "binary file" };
      return { content: buf.toString("utf8") };
    } catch (e: any) {
      return { error: String(e?.message ?? e) };
    }
  });
  ipcMain.handle("last-project", () => lastProject());
  ipcMain.handle("set-last-project", (_e, p: string) => {
    try { fs.writeFileSync(lastProjectFile(), p); } catch { /* ignore */ }
  });
  ipcMain.handle("get-connection", () => conn);
  ipcMain.handle("get-conn-error", () => lastConnError);
  // named SSH hosts managed in Settings > Remote server (list + selected host)
  ipcMain.handle("ssh-hosts-list", () => ({ hosts: sshHosts, active: conn.ssh ? conn.ssh.host : null }));
  ipcMain.handle("ssh-hosts-save", (_e, o: { hosts: any[]; active?: string | null }) => {
    const hosts = (Array.isArray(o?.hosts) ? o.hosts : []).map(normSshHost).filter((h): h is SshHost => !!h);
    const active = typeof o?.active === "string" ? o.active : null;
    if (active && !hosts.some((h) => h.name === active)) return { ok: false, error: "active host not found" };
    saveSshHosts(hosts, active);
    return { ok: true };
  });
  // "Apply & reconnect" in ssh mode: connect to the host selected in Settings
  // (the password window follows if the server asks for one)
  ipcMain.handle("ssh-connect", async (_e, o: { host?: any; token?: string; root?: string | null }) => {
    const t = normSshHost(o?.host);
    if (!t) return { ok: false, error: "no SSH host selected (add one in Settings > Remote server)" };
    reconnecting = true;
    setTimeout(() => { reconnecting = false; }, 15000);
    lastConnError = "";
    return doSetConnection({
      mode: "ssh", host: conn.host, port: conn.port, token: o?.token ?? conn.token, root: o?.root, force: true,
      ssh: { host: t.host, user: t.user, port: t.port, identity: t.identity, remotePort: t.remotePort },
    });
  });
  ipcMain.handle("conn-mode", () => conn.mode);
  ipcMain.handle("set-connection", async (_e, c: object) => {
    reconnecting = true; // cleared when the old proc's exit handler fires (or on timeout)
    setTimeout(() => { reconnecting = false; }, 15000);
    return doSetConnection(c);
  });
  async function doSetConnection(c: any): Promise<object> {
    // switch local <-> remote <-> ssh. c: {mode, host, port, token, ssh?}
    const mode = c.mode === "remote" ? "remote" : c.mode === "ssh" ? "ssh" : "local";
    const next: Connection = {
      mode,
      host: String(c.host || "127.0.0.1"),
      port: Number(c.port) || 8931,
      token: String(c.token || ""),
    };
    if (mode === "ssh") {
      next.ssh = { host: String(c.ssh?.host || ""), user: String(c.ssh?.user || ""),
        port: Number(c.ssh?.port) || 22, identity: String(c.ssh?.identity || ""),
        remotePort: Number(c.ssh?.remotePort) || 8931 };
      if (!next.ssh.host) return { ok: false, error: "ssh host is required" };
    }
    const sameSsh = JSON.stringify(next.ssh ?? null) === JSON.stringify(conn.ssh ?? null);
    if (!c.force && next.mode === conn.mode && next.host === conn.host && next.port === conn.port && next.token === conn.token && sameSsh)
      return { ok: true, reconnected: false };
    saveConn(next);
    // reconnect in place: drop the old connection, then start/connect the new one
    stopReconnect(); // the old socket's close event must not start a remote reconnect
    stopTunnel();    // leave ssh mode: drop the old tunnel (new one starts below if needed)
    if (backend) {
      const old = backend;
      backend = null;
      old.kill("SIGTERM");
      old.stdout?.removeAllListeners();
      await new Promise<void>((res) => {
        const t = setTimeout(() => { try { old.kill("SIGKILL"); } catch { /* ignore */ } res(); }, 2000);
        old.once("exit", () => { clearTimeout(t); res(); });
      });
    }
    closeWs();
    backendUrl = null;
    try {
      let url: string;
      if (next.mode === "remote" || next.mode === "ssh") {
        if (next.mode === "ssh" && next.ssh) {
          const p = await startTunnel(next.ssh);
          url = `ws://127.0.0.1:${p}`;
        } else {
          url = `ws://${next.host}:${next.port}`;
        }
        remoteReconnect = true;
        reconnectDelay = 1000;
        await connectWs(url, next.token);
      } else {
        // switch to local: start the bundled backend with the project the GUI
        // has open (c.root, sent by the renderer) so it is ready to re-open it
        const root = (typeof c.root === "string" && c.root) || backendRoot || lastProject();
        url = await startBackend(root);
        backendRoot = root;
        // startBackend only spawns the process and reads its WS_URL; the socket
        // must be opened here too, or every RPC fails with "backend not connected"
        await connectWs(url);
      }
      backendUrl = url;
      if (window && !window.isDestroyed()) window.webContents.send("backend-url", url);
      return { ok: true, reconnected: true, url };
    } catch (e: any) {
      if (window && !window.isDestroyed()) window.webContents.send("backend-exit", null);
      return { ok: false, error: String(e?.message ?? e) };
    }
  }
  ipcMain.handle("restart-backend", async (_e, root: string | null) => {
    // restart the backend in place (same window): kill the old proc, start a new one.
    // If no project was ever opened (e.g. the first start failed), fall back to
    // the last project so the new backend still starts with a root.
    const r = root ?? backendRoot ?? lastProject();
    if (backend) {
      const old = backend;
      backend = null; // so the old proc's exit handler is ignored
      old.kill("SIGTERM");
      old.stdout?.removeAllListeners();
      // make sure the old proc is really gone before starting the new one,
      // otherwise its stdout pipe can swallow the new WS_URL line
      await new Promise<void>((res) => {
        const t = setTimeout(() => { try { old.kill("SIGKILL"); } catch { /* ignore */ } res(); }, 2000);
        old.once("exit", () => { clearTimeout(t); res(); });
      });
    }
    stopReconnect();
    closeWs();
    try {
      let url: string;
      if (conn.mode === "remote" || conn.mode === "ssh") {
        // remote/ssh mode: "restart" = (re)connect to the remote server
        if (conn.mode === "ssh" && conn.ssh) {
          const p = await startTunnel(conn.ssh);
          url = `ws://127.0.0.1:${p}`;
        } else {
          url = `ws://${conn.host}:${conn.port}`;
        }
        remoteReconnect = true;
        reconnectDelay = 1000;
        await connectWs(url, conn.token);
      } else {
        url = await startBackend(r);
        backendRoot = r;
        // same as doSetConnection: startBackend does not open the socket
        await connectWs(url);
      }
      backendUrl = url;
      if (window && !window.isDestroyed()) window.webContents.send("backend-url", url);
    } catch (e) {
      console.error("[main] backend restart failed:", e);
      if (window && !window.isDestroyed()) window.webContents.send("backend-exit", null);
    }
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindowAsync(root);
  });
});

function killBackend() {
  if (quitting) return;
  quitting = true;
  // local mode: best-effort ask the backend to stop the running turn, then kill
  // the process. Remote mode: the server keeps running on its own machine -
  // closing the GUI must NOT cancel the user's turn, so just drop the socket.
  if (backend) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ id: 0, method: "cancel", params: {} })); } catch { /* ignore */ }
    }
  } else {
    stopReconnect();
    closeWs();
  }
  stopTunnel(); // ssh mode: drop the tunnel (the remote server keeps running)
  const proc = backend;
  if (!proc || proc.exitCode !== null || proc.signalCode) { app.quit(); return; }
  const finish = () => {
    backend = null;
    app.quit();
  };
  const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* ignore */ } }, 2500);
  proc.once("exit", () => { clearTimeout(t); finish(); });
  try { proc.kill("SIGTERM"); } catch { /* already dead */ }
}

app.on("window-all-closed", () => {
  killBackend();
  if (process.platform !== "darwin") app.quit(); // blocked by before-quit while the backend is alive
});

app.on("before-quit", (e) => {
  // never let the app exit while the backend process is still running
  if (backend) {
    e.preventDefault();
    killBackend();
  }
});
