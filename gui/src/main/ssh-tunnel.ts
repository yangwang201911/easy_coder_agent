// SSH tunnel for the "ssh" connection mode: an ssh2 client plus a local port forward
// (127.0.0.1:<random> -> remote 127.0.0.1:<remotePort>). It has no electron imports:
// the password and host-key prompts are injected so it can be tested with an ssh2 server.
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as ssh2 from "ssh2";
import type { SshTarget } from "../types";

// Thrown when a background reconnect would need the user (password / unknown host key).
export class SshInteractionRequired extends Error {}

export interface TunnelHooks {
  // null = the user cancelled; `error` is shown above the field when a password was rejected
  askPassword(target: string, error: string): Promise<string | null>;
  confirmHostKey(hostPort: string, fingerprint: string): Promise<boolean>;
}

export interface TunnelOptions {
  interactive: boolean; // false: never prompt (background reconnect), use cached passwords only
  passwords: Map<string, string>; // session cache, only filled after a successful login
  knownHostsFile: string;
  onClose?: () => void; // the established tunnel went down (not called after close())
}

export interface Tunnel {
  port: number;
  close(): void;
}

const MAX_PASSWORD_PROMPTS = 3;
const WIN_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

export type ParsedTarget = { user: string; host: string; port: number } | { error: string };

// "user@host", "user@host:2222", "user@[::1]:22" or "ssh://user@host"
export function parseSshTarget(input: string): ParsedTarget {
  const s0 = input.trim().replace(/^ssh:\/\//i, "");
  const at = s0.lastIndexOf("@");
  if (at <= 0) return { error: "enter the target as user@host (e.g. ywang2@10.112.106.102)" };
  const user = s0.slice(0, at);
  const rest = s0.slice(at + 1);
  let port = 22;
  let host = rest;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (v6) {
    host = v6[1];
    if (v6[2]) port = Number(v6[2]);
  } else if (/^[^:]+:\d+$/.test(rest)) {
    const i = rest.lastIndexOf(":");
    host = rest.slice(0, i);
    port = Number(rest.slice(i + 1));
  }
  if (!host || /\s/.test(host) || /\s/.test(user)) return { error: "invalid ssh target" };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "invalid ssh port" };
  return { user, host, port };
}

function readKnownHosts(file: string): Record<string, string> {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"));
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function saveKnownHost(file: string, hostPort: string, fingerprint: string) {
  const all = readKnownHosts(file);
  all[hostPort] = fingerprint;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  } catch { /* not persisted: the user is asked again next time */ }
}

function agentPath(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === "win32" && fs.existsSync(WIN_AGENT_PIPE)) return WIN_AGENT_PIPE;
  return undefined;
}

export async function openTunnel(t: SshTarget, hooks: TunnelHooks, opts: TunnelOptions): Promise<Tunnel> {
  const port = t.port || 22;
  const target = `${t.user}@${t.host}`;
  const cacheKey = `${target}:${port}`;
  const hostPort = `${t.host}:${port}`;

  let identityPem: string | undefined;
  if (t.identity) {
    try { identityPem = fs.readFileSync(t.identity, "utf8"); }
    catch (e: any) { throw new Error(`cannot read identity file ${t.identity}: ${e?.message ?? e}`); }
  }
  const agent = identityPem ? undefined : agentPath();

  const client = new ssh2.Client();
  let failure: Error | null = null;
  const fail = (e: Error) => { failure = failure ?? e; };
  let ready = false;
  let closing = false;
  let server: net.Server | null = null;

  let usedPassword: string | null = null; // sent in this attempt, committed to the cache on success
  let awaitingVerdict = false; // a password was sent and the server has not answered yet
  let prompts = 0;
  let lastError = "";

  // the cached password first, then the user (a rejected password is dropped from the cache)
  const nextPassword = async (): Promise<string | null> => {
    if (awaitingVerdict) {
      awaitingVerdict = false;
      opts.passwords.delete(cacheKey);
      lastError = "Permission denied, please try again.";
    }
    const cached = opts.passwords.get(cacheKey);
    if (cached) { usedPassword = cached; awaitingVerdict = true; return cached; }
    if (!opts.interactive) {
      fail(new SshInteractionRequired(`SSH password needed for ${target}`));
      return null;
    }
    if (prompts >= MAX_PASSWORD_PROMPTS) {
      fail(new Error("SSH authentication failed (permission denied)"));
      return null;
    }
    prompts++;
    const p = await hooks.askPassword(target, lastError);
    if (!p) { fail(new Error("SSH login cancelled")); return null; }
    usedPassword = p;
    awaitingVerdict = true;
    return p;
  };

  client.on("error", (e: any) => {
    fail(/authentication methods failed/i.test(String(e?.message))
      ? new Error("SSH authentication failed (permission denied)") : e);
  });

  client.on("keyboard-interactive", (_name, _instr, _lang, kbPrompts, finish) => {
    void nextPassword().then((pw) => finish(kbPrompts.map(() => pw ?? "")));
  });

  const done = new Promise<void>((resolve) => {
    client.once("ready", () => { ready = true; resolve(); });
    client.once("error", () => resolve());
    client.once("close", () => resolve());
  });
  client.on("close", () => {
    if (server) { server.removeAllListeners(); server.close(); server = null; }
    if (ready && !closing) opts.onClose?.();
  });

  const tried = new Set<string>();
  client.connect({
    host: t.host,
    port,
    username: t.user,
    tryKeyboard: true,
    ...(identityPem ? { privateKey: identityPem } : {}),
    ...(agent ? { agent } : {}),
    readyTimeout: 120000, // generous: the user may take a while to type the password
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
    hostHash: "sha256",
    hostVerifier: ((hex: string, verify: (ok: boolean) => void) => {
      const fp = "SHA256:" + Buffer.from(hex, "hex").toString("base64").replace(/=+$/, "");
      const known = readKnownHosts(opts.knownHostsFile)[hostPort];
      if (known === fp) { verify(true); return; }
      if (known) {
        fail(new Error(`HOST KEY CHANGED for ${hostPort} (expected ${known}, got ${fp}). ` +
          `Someone may be intercepting the connection. If the change is expected, remove the entry from ${opts.knownHostsFile}.`));
        verify(false);
        return;
      }
      if (!opts.interactive) {
        fail(new SshInteractionRequired(`unknown host key for ${hostPort}`));
        verify(false);
        return;
      }
      hooks.confirmHostKey(hostPort, fp).then((ok) => {
        if (ok) saveKnownHost(opts.knownHostsFile, hostPort, fp);
        else fail(new Error("SSH host key was not trusted"));
        verify(ok);
      });
    }) as any,
    // methods are offered in this order; a failed method falls through to the next one
    authHandler: (methodsLeft, _partial, nextRaw) => {
      const next = nextRaw as (m: any) => void;
      if (failure) { next(false); return; }
      const left = methodsLeft ?? ["publickey", "agent", "password", "keyboard-interactive"];
      if (left.includes("publickey") && identityPem && !tried.has("publickey")) { tried.add("publickey"); next("publickey"); return; }
      if (left.includes("agent") && agent && !tried.has("agent")) { tried.add("agent"); next("agent"); return; }
      if (left.includes("password")) {
        void nextPassword().then((pw) => {
          if (!pw) { next(false); return; }
          next({ type: "password", username: t.user, password: pw });
        });
        return;
      }
      if (left.includes("keyboard-interactive")) { next("keyboard-interactive"); return; }
      fail(new Error(`no supported ssh auth method (server offers: ${left.join(", ") || "none"})`));
      next(false);
    },
  });

  await done;
  if (!ready) {
    closing = true;
    try { client.end(); } catch { /* ignore */ }
    try { client.destroy(); } catch { /* ignore */ }
    throw failure ?? new Error("ssh connection closed before login finished");
  }
  if (usedPassword) opts.passwords.set(cacheKey, usedPassword);

  const srv = net.createServer((sock) => {
    client.forwardOut("127.0.0.1", 0, "127.0.0.1", t.remotePort, (err, stream) => {
      if (err) { sock.destroy(); return; }
      stream.on("error", () => sock.destroy());
      sock.on("error", () => stream.end());
      stream.pipe(sock);
      sock.pipe(stream);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => resolve());
    });
  } catch (e) {
    closing = true;
    try { client.end(); } catch { /* ignore */ }
    try { client.destroy(); } catch { /* ignore */ }
    throw e;
  }
  server = srv;
  const localPort = (srv.address() as net.AddressInfo).port;
  return {
    port: localPort,
    close() {
      closing = true;
      if (server) { server.removeAllListeners(); server.close(); server = null; }
      try { client.end(); } catch { /* ignore */ }
      try { client.destroy(); } catch { /* ignore */ }
    },
  };
}
