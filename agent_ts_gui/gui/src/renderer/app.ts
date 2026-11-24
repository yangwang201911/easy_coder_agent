// Coder Agent GUI - main window: layout, RPC client, live event rendering.
import markdownit from "markdown-it";
import DOMPurify from "dompurify";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AgentEvent, ReplyMsg, SshHost } from "../types";

// ------------------------------------------------------ markdown (chat only)
const md = markdownit({ html: false, linkify: true, breaks: true });
function renderMarkdown(el: HTMLElement, text: string) {
  el.innerHTML = DOMPurify.sanitize(md.render(text));
  // add a copy button to every code block
  for (const pre of Array.from(el.querySelectorAll("pre"))) {
    const wrap = document.createElement("div");
    wrap.className = "md-code";
    pre.parentNode!.insertBefore(wrap, pre);
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "copy";
    btn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(pre.textContent ?? ""); } catch { /* clipboard unavailable */ }
      btn.textContent = "copied!";
      setTimeout(() => { btn.textContent = "copy"; }, 1200);
    });
    wrap.appendChild(btn);
    wrap.appendChild(pre);
  }
}

// ------------------------------------------------------------------ helpers
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ------------------------------------------------------------------- theme
const THEME_KEY = "agent_ts_gui.theme";
const THEMES = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "solarized", label: "Solarized Light" },
] as const;
type ThemeId = (typeof THEMES)[number]["id"];

function currentTheme(): ThemeId {
  const t = localStorage.getItem(THEME_KEY);
  return THEMES.some((x) => x.id === t) ? (t as ThemeId) : "light";
}
function applyTheme(id: ThemeId) {
  if (id === "light") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
}
applyTheme(currentTheme());

function short(text: string, n: number): string {
  const t = String(text).replace(/\s+/g, " ");
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

function argsSummary(name: string, args: Record<string, any>): string {
  if (name === "run_command") return String(args.command ?? "");
  if (name === "read_file" || name === "list_dir" || name === "write_file" || name === "apply_patch") {
    let extra = "";
    if (name === "read_file" && args.start_line) extra = ` [${args.start_line}-${args.end_line ?? ""}]`;
    return String(args.path ?? ".") + extra;
  }
  return short(JSON.stringify(args), 140);
}

function fmtTok(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}k` : String(Math.round(n));
}

// log panes: append-only, stick to the bottom while the user is at the bottom
class Pane {
  el: HTMLElement;
  constructor(el: HTMLElement) { this.el = el; }
  clear() { this.el.textContent = ""; }
  write(text: string, cls = "", mono = false): HTMLElement {
    const atBottom = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 8;
    const span = document.createElement("span");
    if (cls) span.className = cls;
    if (mono) span.classList.add("m");
    span.textContent = text;
    this.el.appendChild(span);
    if (atBottom) this.el.scrollTop = this.el.scrollHeight;
    return span;
  }
  line(text = "", cls = "", mono = false): HTMLElement {
    return this.write(text + "\n", cls, mono);
  }
}

// ------------------------------------------------- collapsible tool output
// Tool lines in the chat are collapsed to a single line by default; clicking
// the line expands it (multi-line commands / long results) and clicking it
// again collapses it back.
function toggleBlock(span: HTMLElement, full: string, clsName: string) {
  if (span.dataset.full === undefined) { span.dataset.full = full; span.dataset.cls = clsName; }
  const expanded = span.classList.toggle("expanded");
  span.textContent = expanded ? span.dataset.full : short(span.dataset.full, 160);
  span.classList.toggle("c-muted", !expanded && span.dataset.cls !== "c-error");
  const saved = span.dataset.cls;
  if (saved) span.classList.toggle(saved, expanded);
}

// streaming markdown block: keeps the raw text, re-renders the whole block
// (throttled to one frame) so partial code fences self-correct as deltas arrive
class MdBlock {
  el: HTMLElement;
  text = "";
  private dirty = false;
  private done = false;
  constructor(parent: HTMLElement, text = "") {
    this.el = document.createElement("div");
    this.el.className = "md";
    parent.appendChild(this.el);
    this.text = text;
    this.renderNow();
  }
  append(t: string) {
    if (this.done) return;
    this.text += t;
    if (!this.dirty) {
      this.dirty = true;
      requestAnimationFrame(() => { this.dirty = false; if (!this.done) this.renderNow(); });
    }
  }
  finish() { this.done = true; this.renderNow(); }
  private renderNow() {
    const atBottom = chat.el.scrollHeight - chat.el.scrollTop - chat.el.clientHeight < 8;
    renderMarkdown(this.el, this.text);
    if (atBottom) chat.el.scrollTop = chat.el.scrollHeight;
  }
}

const chat = new Pane($("chat"));
const activity = new Pane($("tab-activity"));
const thinking = new Pane($("tab-thinking"));
const commands = new Pane($("tab-commands"));
const planView = $("tab-plan");

// ------------------------------------------------------------------- state
const S = {
  root: null as string | null,
  pendingRoot: null as string | null, // project picked while the backend was not ready
  taskTypes: [] as string[],
  effort: "medium",
  mode: 0, // 0 = single agent, 1 = plan & subtasks
  busy: false,
  ctxMax: 131072,
  compressThreshold: 0.80,
  compressTarget: 0.60,
  config: null as Record<string, any> | null,
  state: "idle",
  stateDetail: "",
  stateSince: 0,
  thinkChars: 0,
  block: null as string | null,
  blockFirst: false,
  mdBlock: null as MdBlock | null,
  curTurnId: null as string | null,
  curTurnBlocks: [] as MdBlock[],
  curTaskType: null as string | null, // task type chosen in the input toolbar (null = auto)
  stepsBody: null as HTMLElement | null, // the collapsed tool activity of the running turn
  stepsCount: 0,
  turnStart: 0,
  approvalPolicy: null as string | null, // user approval policy text (for the input footer chip)
  sessionApprove: false, // "allow all in this session" is active (reset on new session / project)
  attachments: [] as { name: string; data_url: string }[],
  fileAttached: null as string | null,
  toolPaths: new Map<string, string>(), // tool_call id -> file path (for clickable results)
  planDict: null as Record<string, any> | null,
  todos: [] as { content: string; status: string }[], // update_todo checklist (collapsible panel above the input)
};

// --------------------------------------------------------------- rpc client
let nextId = 0;
const pending = new Map<number, (r: any) => void>();
window.api.onReply((msg: ReplyMsg) => {
  const cb = pending.get(msg.id);
  if (!cb) return;
  pending.delete(msg.id);
  if (msg.error) cb({ __error: msg.error });
  else cb(msg.result);
});

function call(method: string, params: Record<string, any> = {}, opts: { waitReady?: boolean; timeoutMs?: number } = {}): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve) => {
    const send = () => {
      const p = window.api.send({ id, method, params });
      if (p && typeof p.catch === "function") {
        p.catch((e: any) => {
          if (pending.has(id)) { pending.delete(id); resolve({ __error: `backend not connected (${e?.message ?? e})` }); }
        });
      }
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ __error: "request timed out" }); }
      }, opts.timeoutMs ?? 120000);
    };
    pending.set(id, resolve);
    // the dialog may be opened while the backend is still starting (boot):
    // wait for a connection URL before sending, so the first RPCs succeed
    if (opts.waitReady) {
      const deadline = Date.now() + (opts.timeoutMs ?? 35000);
      const poll = async () => {
        const u = await window.api.getBackendUrl().catch(() => null);
        if (u) send();
        else if (Date.now() < deadline) setTimeout(poll, 300);
        else send(); // give up waiting; the send's own error/timeout applies
      };
      void poll();
    } else send();
  });
}
// exposed for automated UI tests (CDP)
(window as any).__call = call;

// ------------------------------------------------------------------- status
const STATE_TEXT: Record<string, string> = {
  waiting_model: "Waiting",
  running_tool: "Running tool",
  waiting_user: "Waiting for your approval",
  idle: "Idle",
};

function setState(state: string, detail: string) {
  S.state = state;
  S.stateDetail = detail;
  S.stateSince = Date.now();
  tick();
}

function tick() {
  let text = STATE_TEXT[S.state] ?? S.state;
  if (S.state !== "idle") {
    if (S.stateDetail) text += `: ${S.stateDetail}`;
    text += `  (${Math.floor((Date.now() - S.stateSince) / 1000)}s)`;
    if (S.state === "waiting_model" && S.thinkChars) text += `  thinking ${S.thinkChars} chars`;
  }
  $("state-label").textContent = text;
}
setInterval(tick, 1000);

function setCtxBar(tokens: number, max: number, exact: boolean) {
  const pct = Math.min(100, Math.round((tokens / Math.max(1, max)) * 100));
  $("ctx-fill").style.width = pct + "%";
  const mark = exact ? "" : "~";
  $("ctx-text").textContent = tokens
    ? `context ${mark}${fmtTok(tokens)} / ${fmtTok(max)} (${pct}%)`
    : `context 0 / ${fmtTok(max)}`;
  $("ctx-bar").title =
    `Current cache length: ${tokens.toLocaleString()} tokens (${exact ? "reported by the server" : "local estimate"})\n` +
    `Configured maximum (context.max_tokens): ${max.toLocaleString()}\n` +
    `Compression starts at ${Math.round(S.compressThreshold * 100)}% = ${Math.round(max * S.compressThreshold).toLocaleString()} tokens` +
    ` and shrinks to ${Math.round(S.compressTarget * 100)}%.`;
}

function refreshContextEstimate() {
  call("context_estimate").then((r) => {
    if (r && !r.__error) setCtxBar(r.tokens, r.max_tokens, false);
  });
}

async function refreshServerInfo() {
  const btn = $("server-ctx-btn");
  btn.textContent = "server cache: checking...";
  btn.className = "flat";
  btn.title = "";
  const r = await call("context_info");
  if (r && r.__error) { btn.textContent = "server cache: ?"; return; }
  const info = r.context;
  const mx = r.configured_max;
  if (!info.loaded && !info.model_max) {
    btn.textContent = "server cache: unknown";
    btn.title = `${r.context_text}\nClick to retry.`;
    return;
  }
  const parts: string[] = [];
  if (info.loaded) parts.push(`server cache ${fmtTok(info.loaded)}` + (info.loaded_is_configured ? " (configured)" : ""));
  if (info.model_max) parts.push(`model max ${fmtTok(info.model_max)}`);
  btn.textContent = parts.join(" | ");
  const tip = [r.context_text, `Configured context.max_tokens: ${mx.toLocaleString()}`];
  if (info.loaded && mx > info.loaded) {
    btn.className = "flat bad";
    tip.push("WARNING: the configured maximum is larger than the server's cache, so compression would start " +
      "too late and requests may be truncated. Settings > Context & agent > Detect.");
  } else if (info.loaded && mx !== info.loaded) {
    btn.className = "flat warn";
    tip.push("The configured maximum is smaller than the server's cache (safe, but part of it is unused). " +
      "Settings > Context & agent > Detect.");
  }
  tip.push("Click to refresh.");
  btn.title = tip.join("\n");
}

// ------------------------------------------------------------------ toolbar
const SEND_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" style="display:block"><path d="M8 13 V3 M3.5 7.5 L8 3 L12.5 7.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const STOP_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" style="display:block"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="5.4" y="5.4" width="5.2" height="5.2" rx="1" fill="currentColor"/></svg>';

function setBusy(busy: boolean) {
  S.busy = busy;
  const sb = $("send-btn") as HTMLButtonElement;
  sb.classList.toggle("stopping", busy);
  sb.innerHTML = busy ? STOP_ICON : SEND_ICON;
  sb.title = busy ? "Stop the running turn" : "Send (Enter)";
}

// the task type is chosen in the input toolbar's ＋ menu (not a toolbar select)
function reloadTaskTypes() {
  if (S.curTaskType && !S.taskTypes.includes(S.curTaskType)) S.curTaskType = null;
}

// model chip in the input toolbar: "model · context" (click -> Settings)
function refreshModelLabel() {
  const model = S.config?.server?.model ?? "";
  const el = $("model-combo");
  el.textContent = model ? `${model} · ${fmtTok(S.ctxMax)}` : "model · ?";
  el.title = model
    ? `Model: ${model}\nContext: ${fmtTok(S.ctxMax)} tokens\nClick to open Settings > Model`
    : "No model configured (Settings > Model)";
}

// thinking-effort chip in the input toolbar: plain text, click for the options
function refreshEffortLabel() {
  const el = $("effort-combo-label");
  el.textContent = S.effort;
  ($("effort-combo") as HTMLButtonElement).title = `Thinking effort: ${S.effort} (click to change)`;
}

// connection chip under the input card: "Local" / "Remote host:port"
async function refreshConnLabel() {
  const mode = await window.api.getConnMode().catch(() => "local");
  const text = $("conn-mode-text");
  const btn = $("conn-mode-label");
  if (mode === "remote" || mode === "ssh") {
    const c = await window.api.getConnection().catch(() => null);
    if (mode === "ssh" && c?.ssh) {
      text.textContent = `SSH ${c.ssh.user ? c.ssh.user + "@" : ""}${c.ssh.host}`;
      btn.title = `Connected via ssh tunnel to ${c.ssh.user ? c.ssh.user + "@" : ""}${c.ssh.host} (server port ${c.ssh.remotePort})\nClick to change the connection (Settings > Remote server)`;
    } else {
      text.textContent = c ? `Remote ${c.host}:${c.port}` : "Remote";
      btn.title = `Connected to remote agent server ${c ? c.host + ":" + c.port : ""}\nClick to change the connection (Settings > Remote server)`;
    }
  } else {
    text.textContent = "Local";
    btn.title = "Agent runs on this machine (local mode). Click for Settings > Remote server";
  }
}

// approval chip under the input card: "Default permissions" / "Allow all in this session" / "Auto-approve"
function refreshApprovalLabel() {
  const text = $("approval-text");
  const btn = $("approval-label");
  const auto = /auto_approve_all\s*=\s*true/.test(S.approvalPolicy ?? "");
  if (S.sessionApprove) {
    text.textContent = "Allow all in this session";
    btn.title = "Everything not denied in the approval policy runs without asking, until this session ends (new session / project resets it).\nClick to open Settings > Approval";
  } else if (auto) {
    text.textContent = "Auto-approve";
    btn.title = `Approval policy: auto_approve_all = true\nClick to open Settings > Approval`;
  } else {
    text.textContent = "Default permissions";
    btn.title = "Ask before running commands / writing files\nClick to open Settings > Approval";
  }
}

function savedProjectFor(root: string): SavedProject | null {
  return loadProjects().find((p) => p.path === root) ?? null;
}

async function openProject(root: string, sessionId: string | null = null) {
  const r = await call("open_project", { root, session_id: sessionId });
  if (r && r.__error) { chat.line(`\n[error] open project: ${r.__error}`, "c-error"); return; }
  clearBackendDown();
  S.root = r.root;
  S.taskTypes = r.task_types;
  S.effort = r.effort;
  S.ctxMax = r.config?.context?.max_tokens ?? S.ctxMax;
  S.compressThreshold = r.config?.context?.compress_threshold ?? 0.95;
  S.compressTarget = r.config?.context?.compress_target ?? 0.5;
  S.config = r.config;
  S.sessionApprove = !!r.session_approve; // reset for a new engine, kept when resuming
  let saved = savedProjectFor(r.root);
  if (!saved) {
    // a project opened outside the dialog (e.g. --root at boot): remember it
    // under its folder name so it can be re-opened by name next time. The
    // mode follows the connection: the path is on the machine the backend
    // runs on (this machine in local mode, the server in remote mode).
    const connMode = (await window.api.getConnMode().catch(() => "local")) as "local" | "remote" | "ssh";
    // ssh mode's project lives on the server machine too: store it as "remote"
    saved = { name: r.root.split(/[\\/]/).filter(Boolean).pop() ?? r.root, mode: connMode === "local" ? "local" : "remote", path: r.root };
    rememberProject(saved.name, saved.mode, saved.path);
  }
  setLastProjectName(saved.name);
  // the open project's path lives in the title bar, not on the Project button
  $("titlebar-name").textContent = `Coder Agent: ${r.root}`;
  ($("rail-project") as HTMLElement).title = `Project: ${saved ? saved.name + " (" + saved.mode + ")\n" : ""}${r.root}\nClick to show the turns of this project`;
  document.title = `Coder Agent: ${r.root}`;
  refreshEffortLabel();
  // the last-project record is only meaningful for local paths; in remote mode
  // the project lives on the server machine (remembered by name in localStorage)
  window.api.getConnMode().then((m) => { if (m === "local") window.api.setLastProject(r.root); }).catch(() => {});
  reloadTaskTypes();
  refreshModelLabel();
  refreshApprovalLabel();
  void (async () => {
    const r = await call("approval_policy");
    if (r && !r.__error) { S.approvalPolicy = r.text; refreshApprovalLabel(); }
  })();
  resetViews();
  await replaySession();
  await refreshTurnList();
  await refreshSessionList();
  refreshContextEstimate();
  refreshServerInfo();
  clearFileView();
  void refreshFileTree();
  // open the current session's chat view
  const cur = await call("session_summaries");
  const title = cur && !cur.__error
    ? (cur.sessions.find((s: any) => s.id === cur.current)?.title ?? "(empty)")
    : "";
  showSessionChat(`session: ${title}`);
}

function resetViews() {
  chat.clear(); activity.clear(); thinking.clear();
  planView.innerHTML = "";
  S.planDict = null;
  renderTodos();
  S.block = null;
  S.mdBlock = null;
  S.curTurnBlocks = [];
  S.stepsBody = null;
  S.stepsCount = 0;
  S.thinkChars = 0;
  $("llm-label").textContent = "";
  setState("idle", "");
}

// ------------------------------------------------------- chat rendering
// clickable file name: opens the file in the main file viewer
function fileLinkEl(path: string): HTMLElement {
  const a = document.createElement("span");
  a.className = "file-link";
  a.textContent = path;
  a.title = "Open in file viewer";
  a.addEventListener("click", (e) => { e.stopPropagation(); openFile(path, false); });
  return a;
}

// the tool activity of the current turn: while a turn runs the lines are
// visible; at turn_finished they collapse behind the "Completed N steps" chip
function stepsPane(): HTMLElement { return S.stepsBody ?? chat.el; }

function chatTool(name: string, args: Record<string, any>, agent = "main") {
  const who = agent === "main" ? "" : `[${agent}] `;
  S.mdBlock?.finish();
  S.mdBlock = null;
  const full = `> ${who}${name}  ${argsSummary(name, args)}`;
  const pane = stepsPane();
  const pwrite = (t: string, cls = "") => {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    s.textContent = t;
    pane.appendChild(s);
    return s;
  };
  pwrite("\n", "c-tool m");
  const body = pwrite("", "c-tool m");
  body.appendChild(document.createTextNode(`> ${who}${name}  `));
  const p = String(args.path ?? "");
  if (p) {
    // file tools: the path is a clickable tag (no collapse, it would destroy the link)
    body.appendChild(fileLinkEl(p));
    if (name === "read_file" && args.start_line) {
      body.appendChild(document.createTextNode(` [${args.start_line}-${args.end_line ?? ""}]`));
    }
  } else {
    body.appendChild(document.createTextNode(argsSummary(name, args)));
    body.classList.add("collapsible");
    body.addEventListener("click", () => toggleBlock(body, full, "c-tool m"));
  }
  pwrite("\n", "c-tool m");
  S.block = null;
}

function chatResult(ok: boolean, text: string, toolName = "", path = "") {
  if (ok && path && (toolName === "write_file" || toolName === "apply_patch")) {
    // file written/patched: show only the clickable file name, not the content/diff
    const cls = "c-muted m";
    const pane = stepsPane();
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = "\n  ";
    pane.appendChild(s);
    const link = fileLinkEl(path);
    pane.appendChild(link);
    pane.appendChild(document.createTextNode("\n"));
    return;
  }
  const full = "  " + text;
  const cls = (ok ? "c-muted" : "c-error") + " m";
  const pane = stepsPane();
  const body = document.createElement("span");
  body.className = cls;
  body.textContent = short(full, 300);
  body.classList.add("collapsible");
  body.addEventListener("click", () => toggleBlock(body, full, cls));
  pane.appendChild(body);
  pane.appendChild(document.createTextNode("\n"));
}

// user prompt as a rounded card (Claude-Code style)
function userPromptCard(prompt: string, head = ""): HTMLElement {
  const card = document.createElement("div");
  card.className = "user-card";
  if (head) {
    const h = document.createElement("span");
    h.className = "uc-head";
    h.textContent = head;
    card.appendChild(h);
  }
  card.appendChild(document.createTextNode(prompt));
  chat.el.appendChild(card);
  return card;
}

// "Completed N steps in Xs" chip + the collapsible tool activity it hides
function stepsChipEl(): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "steps-chip";
  chip.innerHTML = `<span class="chip-label"></span><span class="chip-arrow">▸</span>`;
  const body = document.createElement("div");
  body.className = "steps-body";
  chip.addEventListener("click", () => {
    const open = body.classList.toggle("open");
    chip.querySelector(".chip-arrow")!.textContent = open ? "▾" : "▸";
  });
  chat.el.appendChild(chip);
  chat.el.appendChild(body);
  return body;
}

function updateStepsChip() {
  if (!S.stepsBody) return;
  const chip = S.stepsBody.previousElementSibling as HTMLElement | null;
  if (!chip || !chip.classList.contains("steps-chip")) return;
  const secs = Math.max(1, Math.round((Date.now() - S.turnStart) / 1000));
  chip.querySelector(".chip-label")!.textContent =
    `Completed ${S.stepsCount} step${S.stepsCount === 1 ? "" : "s"} in ${secs}s`;
}

// action row shown after a finished turn: re-send this turn / copy its answer
function turnActionBar(turnId: string, blocks: MdBlock[]) {
  const row = document.createElement("div");
  row.className = "turn-actions";
  const mk = (label: string, title: string, fn: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", fn);
    row.appendChild(b);
  };
  mk("↻", "Re-send this prompt (rewinds to it first)", () => void resendTurn(turnId));
  mk("⧉", "Copy this turn's answer", async () => {
    const text = blocks.map((b) => b.text).filter(Boolean).join("\n\n");
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard unavailable */ }
  });
  chat.el.appendChild(row);
}

function renderTurn(t: { prompt: string; task_type: string; messages: any[]; status: string; created?: number; id?: string }) {
  userPromptCard(t.prompt, t.created ? `[${t.task_type}]  ${stampOf(t.created)}` : `[${t.task_type}]`);
  // tool activity: replayed collapsed behind the steps chip
  const body = stepsChipEl();
  S.stepsBody = body;
  let steps = 0;
  for (const m of t.messages) {
    if (m.role === "assistant") {
      for (const tc of m.tool_calls ?? []) {
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { args = { raw: tc.function.arguments }; }
        chatTool(tc.function.name, typeof args === "object" && args ? args : {});
        steps += 1;
      }
    } else if (m.role === "tool") {
      const c = m.content ?? "";
      const tcid = m.tool_call_id ?? "";
      const tc = t.messages.find((x: any) => x.role === "assistant" && (x.tool_calls ?? []).some((y: any) => y.id === tcid));
      const tcall = tc?.tool_calls?.find((y: any) => y.id === tcid);
      let args: any = {};
      try { args = JSON.parse(tcall?.function?.arguments || "{}"); } catch { args = {}; }
      const ok = !c.startsWith("ERROR") && !c.startsWith("DENIED") && !c.startsWith("REJECTED");
      chatResult(ok, c, tcall?.function?.name ?? "", String(args.path ?? ""));
    }
  }
  S.stepsCount = steps;
  const chip = body.previousElementSibling as HTMLElement;
  // the replayed duration is not stored; show the step count only
  chip.querySelector(".chip-label")!.textContent =
    `Completed ${steps} step${steps === 1 ? "" : "s"}`;
  if (steps === 0) { chip.remove(); body.remove(); }
  S.stepsBody = null;
  // the final answer, after the chip
  const blocks: MdBlock[] = [];
  for (const m of t.messages) {
    if (m.role === "assistant" && m.content) {
      const b = new MdBlock(chat.el, String(m.content).replace(/^\n+/, ""));
      b.finish();
      blocks.push(b);
    }
  }
  if (t.id && blocks.length) turnActionBar(t.id, blocks);
}

async function replaySession() {
  const r = await call("session_detail");
  if (!r || r.__error) return;
  for (const t of r.turns) renderTurn(t);
  chat.el.scrollTop = chat.el.scrollHeight;
}

// ------------------------------------------------- left panels (turns / sessions)
async function refreshTurnList() {
  const r = await call("session_turns");
  if (!r || r.__error) return;
  const ul = $("turn-list");
  (ul as any).__turns = r.turns;
  ul.innerHTML = "";
  for (const t of r.turns) {
    const li = document.createElement("li");
    li.dataset.id = t.id;
    li.title = t.prompt;
    li.textContent = t.active
      ? `${t.index}. [${t.status}] ${short(t.prompt, 60)}`
      : `(branch) [${t.status}] ${short(t.prompt, 54)}`;
    if (!t.active) li.classList.add("branch");
    ul.appendChild(li);
  }
}

// ------------------------------------------------- session chat view
// Clicking a session hides the sessions list and shows the chat (output) of
// that session above the input box; the ← button goes back to the list.
let sessionClickTimer: number | null = null;

function showSessionChat(title: string) {
  switchLeftTab("sessions");
  $("session-list-view").classList.add("hidden");
  $("session-chat-view").classList.remove("hidden");
  $("chat-view-title").textContent = title;
  ($("input") as HTMLTextAreaElement).placeholder =
    "Describe the task...  (Enter to send, Ctrl+Enter for newline, paste images to attach)";
  requestAnimationFrame(() => { chat.el.scrollTop = chat.el.scrollHeight; });
}

function showSessionList() {
  $("session-chat-view").classList.add("hidden");
  $("session-list-view").classList.remove("hidden");
  ($("input") as HTMLTextAreaElement).placeholder =
    "Describe the task...  (sending here starts a NEW session, Enter to send)";
}

$("chat-back-btn").addEventListener("click", showSessionList);

async function refreshSessionList() {
  const r = await call("session_summaries");
  if (!r || r.__error) return;
  const ul = $("session-list");
  ul.innerHTML = "";
  let lastClicked: HTMLElement | null = null;
  for (const s of r.sessions) {
    const when = new Date(s.updated * 1000);
    const stamp = `${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")} ` +
      `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
    const li = document.createElement("li");
    li.textContent = `${s.id === r.current ? "● " : ""}${stamp}  ${s.title || "(empty)"}`;
    li.title = `${s.title}\n${s.turns} turn(s), last status: ${s.status}\n${s.id}`;
    if (s.id === r.current) li.classList.add("current");
    li.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey) {
        li.classList.toggle("selected");
      } else if (e.shiftKey && lastClicked) {
        const items = Array.from(ul.children) as HTMLElement[];
        const a = items.indexOf(lastClicked), b = items.indexOf(li);
        for (const it of items.slice(Math.min(a, b), Math.max(a, b) + 1)) it.classList.add("selected");
      } else {
        for (const it of ul.children) it.classList.remove("selected");
        li.classList.add("selected");
      }
      lastClicked = li;
      // single click opens the chat view - only for the current session (the
      // chat shows the current session's turns; other sessions are switched
      // to with a double click, which then opens the chat as well). Deferred
      // so a double click does not also fire.
      if (sessionClickTimer) window.clearTimeout(sessionClickTimer);
      if (s.id === r.current) {
        const title = `session: ${s.title || "(empty)"}`;
        sessionClickTimer = window.setTimeout(() => { sessionClickTimer = null; showSessionChat(title); }, 280);
      }
    });
    li.addEventListener("dblclick", () => {
      if (sessionClickTimer) { window.clearTimeout(sessionClickTimer); sessionClickTimer = null; }
      if (S.busy || s.id === r.current) return;
      openProject(S.root!, s.id).then(() => showSessionChat(`session: ${s.title || "(empty)"}`));
    });
    li.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();  // the document-level handler would hide the menu right away
      const sel = Array.from(ul.querySelectorAll("li.selected")).map((el) => (el as HTMLElement).dataset.id!);
      if (!sel.includes(s.id)) {
        for (const it of ul.children) it.classList.remove("selected");
        li.classList.add("selected");
        sel.push(s.id);
      }
      showMenu(e.clientX, e.clientY, [
        { label: "Open", enabled: !S.busy && s.id !== r.current,
          fn: () => openProject(S.root!, s.id).then(() => showSessionChat(`session: ${s.title || "(empty)"}`)) },
        { label: sel.length > 1 ? `Delete ${sel.length} selected sessions...` : "Delete session...",
          enabled: !S.busy, fn: () => deleteSessions(sel) },
      ]);
    });
    li.dataset.id = s.id;
    ul.appendChild(li);
  }
}

async function deleteSessions(ids: string[]) {
  const n = ids.length;
  const ok = await confirmModal("Delete session" + (n > 1 ? "s" : ""),
    `Delete ${n} session${n > 1 ? "s" : ""} and their file snapshots?\n` +
    "Files in the project are not touched, but these sessions can no longer be rewound.");
  if (!ok) return;
  const r = await call("delete_sessions", { session_ids: ids });
  if (r && r.__error) { chat.line(`\n[error] ${r.__error}`, "c-error"); return; }
  if (r.new_session) {
    // the current session was deleted: the backend started a fresh one
    S.sessionApprove = false; // new session: "allow all in this session" is reset
    refreshApprovalLabel();
    resetViews();
    await refreshTurnList();
    await refreshSessionList();
    refreshContextEstimate();
    chat.line("\n[new session started]", "c-muted");
  } else {
    await refreshSessionList();
  }
}

// ------------------------------------------------- file tree + file viewer
// Lazy tree of the project (VS Code explorer style): one level per click,
// loaded through the file_tree RPC (works for local and remote backends).
// The mid pane shows open panes as tabs: project files and web pages. Each tab
// keeps its own content; web panes render an iframe preview of the page.
type OpenFile = { kind: "file"; path: string; content: string | null; loading: boolean; changed: boolean; loadSeq: number };
type OpenWeb = { kind: "web"; path: string; url: string; loading: boolean };
type OpenPane = OpenFile | OpenWeb;
const S_FILES: OpenPane[] = [];
let S_FILES_ACTIVE: string | null = null;
// paths of files modified in this session, filled by loadTreeLevel
let S_CHANGED_FILES: Set<string> | null = null;

function paneLabel(p: OpenPane): string {
  if (p.kind === "web") {
    try { const u = new URL(p.url); return u.host + (u.pathname === "/" ? "" : u.pathname); }
    catch { return p.url; }
  }
  return fileName(p.path);
}

async function loadTreeLevel(container: HTMLElement, relPath: string, depth: number) {
  const r = await call("file_tree", { path: relPath });
  if (r && r.__error) {
    const err = document.createElement("div");
    err.className = "tree-err";
    err.textContent = r.__error;
    container.appendChild(err);
    return;
  }
  for (const e of r.entries) {
    const full = (relPath ? relPath + "/" : "") + e.name;
    if (e.changed && !e.dir && S_CHANGED_FILES) S_CHANGED_FILES.add(full);
    const row = document.createElement("div");
    row.className = "tree-row" + (e.dir ? " dir" : "") + (e.changed ? " changed" : "");
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.title = (relPath ? relPath + "/" : "") + e.name + (e.changed ? "\nmodified in this session" : "");
    const ico = document.createElement("span");
    ico.className = "tree-ico";
    ico.textContent = e.dir ? (e.changed ? "📂" : "📁") : (e.changed ? "✎" : "📄");
    row.appendChild(ico);
    const name = document.createElement("span");
    name.textContent = e.name;
    row.appendChild(name);
    if (e.changed) {
      const dot = document.createElement("span");
      dot.className = "tree-dot";
      dot.title = "modified in this session";
      row.appendChild(dot);
    }
    container.appendChild(row);
    if (e.dir) {
      // arrow toggles the (lazily created) child container; dirs that contain
      // changed files are auto-expanded so they are never hidden
      const arrow = document.createElement("span");
      arrow.className = "tree-arrow";
      const open = e.changed;
      arrow.textContent = open ? "▾" : "▸";
      row.insertBefore(arrow, ico);
      const child = document.createElement("div");
      child.className = "tree-children" + (open ? "" : " hidden");
      container.appendChild(child);
      let loaded = false;
      if (open) {
        loaded = true;
        void loadTreeLevel(child, relPath ? relPath + "/" + e.name : e.name, depth + 1);
      }
      row.addEventListener("click", async () => {
        const hidden = child.classList.toggle("hidden");
        arrow.textContent = hidden ? "▸" : "▾";
        if (!hidden && !loaded) {
          loaded = true;
          await loadTreeLevel(child, relPath ? relPath + "/" + e.name : e.name, depth + 1);
        }
      });
    } else {
      row.addEventListener("click", () => {
        for (const el of document.querySelectorAll(".tree-row.sel")) el.classList.remove("sel");
        row.classList.add("sel");
        openFile(relPath ? relPath + "/" + e.name : e.name, e.changed);
      });
    }
  }
}

async function refreshFileTree() {
  const root = $("file-tree");
  root.innerHTML = "";
  if (!S.root) { root.innerHTML = '<div class="muted" style="padding:8px">no project open</div>'; return; }
  // collect the modified files while loading the (lazy) tree, then refresh
  // the open-file tabs: update their "modified" flag and reload their content
  // (the agent may have changed them)
  S_CHANGED_FILES = new Set<string>();
  await loadTreeLevel(root, "", 0);
  for (const f of S_FILES) {
    if (f.kind !== "file") continue;
    f.changed = S_CHANGED_FILES.has(f.path);
    if (f.content != null) void loadFile(f);
  }
  renderFileTabs();
}

// ------------------------------------------------- file viewer (mid pane)
// Open files are tabs; clicking a tab shows that file, the close button
// removes it. Content is loaded once per file and kept in S_FILES.
function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function renderFileTabs() {
  const bar = $("file-tabs");
  bar.innerHTML = "";
  for (const f of S_FILES) {
    const tab = document.createElement("div");
    tab.className = "ftab" + (f.path === S_FILES_ACTIVE ? " active" : "") + (f.kind === "web" ? " ftab-web" : "");
    tab.title = f.kind === "web" ? f.url : f.path;
    if (f.kind === "web") {
      const ico = document.createElement("span");
      ico.className = "ftab-ico";
      ico.textContent = "\u{1F310}";
      tab.appendChild(ico);
    }
    const name = document.createElement("span");
    name.className = "fname";
    name.textContent = paneLabel(f);
    tab.appendChild(name);
    if (f.kind === "file" && f.changed) {
      const dot = document.createElement("span");
      dot.className = "fdot";
      dot.title = "modified in this session";
      tab.appendChild(dot);
    }
    const close = document.createElement("button");
    close.className = "fclose";
    close.textContent = "\u2715";
    close.title = f.kind === "web" ? "Close page" : "Close file";
    close.addEventListener("click", (e) => { e.stopPropagation(); closeFile(f.path); });
    tab.appendChild(close);
    tab.addEventListener("click", () => activateFile(f.path));
    bar.appendChild(tab);
  }
}

function renderFileBody() {
  const body = $("file-body");
  body.innerHTML = "";
  const f = S_FILES.find((x) => x.path === S_FILES_ACTIVE);
  if (!f) {
    body.innerHTML = '<div class="muted">select a file in the Files tab</div>';
    return;
  }
  if (f.kind === "web") { renderWebBody(body, f); return; }
  if (f.loading) { body.innerHTML = '<div class="muted">loading...</div>'; return; }
  if (f.content == null) { body.innerHTML = '<div class="c-error">failed to load file</div>'; return; }
  const lines = f.content.split("\n");
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {
    const line = document.createElement("div");
    line.className = "fline";
    const no = document.createElement("span");
    no.className = "fno";
    no.textContent = String(i + 1);
    const txt = document.createElement("span");
    txt.className = "ftext";
    txt.textContent = lines[i] === "" ? " " : lines[i];
    line.append(no, txt);
    frag.appendChild(line);
  }
  body.appendChild(frag);
}

function renderFileView() {
  renderFileTabs();
  renderFileBody();
  renderFileAttachTag();
}

// ------------------------------------------------- web page panes (mid pane)
// A web pane shows a live iframe of a local page. The "+screenshot" tag above
// the input box captures the page (via a hidden browser window) and attaches
// the image to the next message, so the model can see and fix the page.
function renderWebBody(body: HTMLElement, f: OpenWeb) {
  const bar = document.createElement("div");
  bar.className = "webbar";
  const url = document.createElement("span");
  url.className = "webbar-url";
  url.textContent = f.url;
  url.title = f.url;
  const refresh = document.createElement("button");
  refresh.className = "webbar-btn";
  refresh.textContent = "refresh";
  refresh.title = "Reload the page";
  refresh.addEventListener("click", () => {
    const fr = body.querySelector("iframe.webframe") as HTMLIFrameElement | null;
    if (fr) fr.src = f.url;
  });
  const ext = document.createElement("a");
  ext.className = "webbar-btn webbar-ext";
  ext.textContent = "open";
  ext.title = "Open in the system browser";
  ext.href = f.url;
  ext.target = "_blank";
  ext.rel = "noreferrer";
  bar.append(url, refresh, ext);
  body.appendChild(bar);
  const wrap = document.createElement("div");
  wrap.className = "webframe-wrap";
  const fr = document.createElement("iframe");
  fr.className = "webframe";
  fr.src = f.url;
  fr.allow = "clipboard-write";
  wrap.appendChild(fr);
  body.appendChild(wrap);
}

function openWeb(url: string) {
  const u = url.trim();
  if (!u) return;
  try { new URL(u); } catch { chat.line(`\n[not a valid url: ${u}]`, "c-warn"); return; }
  const path = "web:" + u;
  const existing = S_FILES.find((x) => x.path === path);
  if (existing) { activateFile(path); return; }
  const f: OpenWeb = { kind: "web", path, url: u, loading: false };
  S_FILES.push(f);
  S_FILES_ACTIVE = path;
  renderFileView();
}

// exposed for automated UI tests (CDP)
(window as any).__openWeb = openWeb;
Object.defineProperty(window, "__openPanes", { get: () => S_FILES.map((p) => ({ kind: p.kind, path: p.path, url: (p as OpenWeb).url ?? null })) });

function activateFile(path: string) {
  S_FILES_ACTIVE = path;
  renderFileView();
}

function closeFile(path: string) {
  const i = S_FILES.findIndex((f) => f.path === path);
  if (i < 0) return;
  S_FILES.splice(i, 1);
  if (S_FILES_ACTIVE === path) {
    S_FILES_ACTIVE = S_FILES.length ? S_FILES[Math.max(0, i - 1)].path : null;
  }
  renderFileView();
}

function openFile(path: string, changed: boolean) {
  const existing = S_FILES.find((f) => f.path === path);
  if (existing) {
    if (existing.kind !== "file") { activateFile(path); return; }
    existing.changed = changed;
    if (existing.content != null) { activateFile(path); return; }
    if (!existing.loading) void loadFile(existing);
    activateFile(path);
    return;
  }
  const f: OpenFile = { kind: "file", path, content: null, loading: true, changed, loadSeq: 0 };
  S_FILES.push(f);
  S_FILES_ACTIVE = path;
  renderFileView();
  void loadFile(f);
}

async function loadFile(f: OpenFile) {
  f.loading = true;
  const seq = ++f.loadSeq; // a newer load invalidates this one
  if (f.path === S_FILES_ACTIVE) renderFileBody();
  const r = await call("file_content", { path: f.path });
  if (seq !== f.loadSeq) return; // superseded by a newer load
  f.content = r && r.__error ? null : r.content;
  f.loading = false;
  if (f.path === S_FILES_ACTIVE) {
    renderFileBody();
    // the tag only appears once the content has loaded
    renderFileAttachTag();
  }
}

function clearFileView() {
  S_FILES.length = 0;
  S_FILES_ACTIVE = null;
  renderFileView();
}

// ------------------------------------------------- attach current pane to prompt
// When the main pane shows an open file, a "+name" tag appears above the input
// box. Clicking it attaches the file's content to the next message (shown as
// "xname"); clicking again detaches it. For a web page the tag is
// "+screenshot": clicking it captures the page and attaches the image to the
// next message (the model can then see and adjust the page).
function renderFileAttachTag() {
  const tag = $("file-attach-tag") as HTMLElement;
  const active = S_FILES_ACTIVE ? S_FILES.find((f) => f.path === S_FILES_ACTIVE) : null;
  if (!active || (active.kind === "file" && active.content == null)) {
    S.fileAttached = null;
    tag.classList.add("hidden");
    tag.innerHTML = "";
    return;
  }
  tag.classList.remove("hidden");
  const attached = S.fileAttached === active.path;
  tag.className = "file-attach-tag" + (attached ? " attached" : "");
  tag.innerHTML = "";
  const icon = document.createElement("span");
  icon.className = "fatag-icon";
  icon.textContent = attached ? "✕" : "+";
  const name = document.createElement("span");
  name.textContent = active.kind === "web" ? "screenshot" : fileName(active.path);
  tag.title = active.kind === "web"
    ? (attached ? `Remove the screenshot of ${active.url} from the next message`
                : `Capture ${active.url} and attach the screenshot to the next message`)
    : (attached ? `Remove ${active.path} from the next message`
                : `Attach ${active.path} to the next message`);
  tag.append(icon, name);
  tag.onclick = () => {
    if (active.kind === "web") {
      if (attached) {
        S.fileAttached = null;
        // drop the captured image with it
        const name = "screenshot " + paneLabel(active);
        S.attachments = S.attachments.filter((a) => a.name !== name);
        renderAttachStrip();
        renderFileAttachTag();
        return;
      }
      S.fileAttached = active.path;
      renderFileAttachTag();
      void captureWebToPrompt(active);
      return;
    }
    S.fileAttached = attached ? null : active.path;
    renderFileAttachTag();
  };
}

async function captureWebToPrompt(f: OpenWeb) {
  chat.line(`\n[capturing ${f.url} ...]`, "c-muted");
  const r = await window.api.webCapture(f.url);
  if (r.error) {
    chat.line(`\n[screenshot failed: ${r.error}]`, "c-error");
    S.fileAttached = null;
    renderFileAttachTag();
    return;
  }
  const name = "screenshot " + paneLabel(f);
  // drop any previous capture of the same page, then attach the fresh one
  S.attachments = S.attachments.filter((a) => a.name !== name);
  await addImages([{ name, data_url: r.data_url! }]);
  chat.line(`\n[attached ${name} - it will be sent with your next message]`, "c-ok");
}

// called from send(): appends the attached file's content to the prompt.
// Must be called BEFORE startNewSession(): that clears the file view and
// would silently drop the attachment.
async function withAttachedFile(prompt: string): Promise<string> {
  if (!S.fileAttached) return prompt;
  const f = S_FILES.find((x) => x.path === S.fileAttached);
  S.fileAttached = null;
  renderFileAttachTag();
  if (!f || f.kind !== "file" || f.content == null) return prompt;
  let content = f.content;
  let note = "";
  if (content.length > MAX_FILE_CHARS) {
    content = content.slice(0, MAX_FILE_CHARS);
    note = `\n... (truncated, ${content.length} of ${f.content!.length} chars)`;
  }
  const sep = prompt && !prompt.endsWith("\n") ? "\n" : "";
  return `${prompt}${sep}\n<file ${f.path}>\n${content}${note}\n</file>\n`;
}

// ------------------------------------------------- context menu + modal
function showMenu(x: number, y: number, items: { label: string; enabled?: boolean; fn?: () => void }[]) {
  const menu = $("ctxmenu");
  menu.innerHTML = "";
  for (const it of items) {
    const el = document.createElement("div");
    el.className = "item" + (it.enabled === false ? " disabled" : "");
    el.textContent = it.label;
    if (it.enabled !== false && it.fn) el.addEventListener("click", () => { hideMenu(); it.fn!(); });
    menu.appendChild(el);
  }
  menu.style.display = "block";
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 4) + "px";
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 4) + "px";
}
function hideMenu() { $("ctxmenu").style.display = "none"; }
document.addEventListener("click", hideMenu);
document.addEventListener("contextmenu", (e) => {
  // close the menu unless the event is on the menu itself
  if (!(e.target as HTMLElement).closest("#ctxmenu")) hideMenu();
});
window.addEventListener("blur", hideMenu);

// Electron has no window.prompt (it silently returns null), so the projects
// dialog needs its own input modal. It is a separate overlay appended to the
// body, so it can stack on top of the projects dialog.
function promptModal(title: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const bd = document.createElement("div");
    bd.className = "modal-backdrop stacked show";
    bd.innerHTML = `<div class="modal prompt"><div class="head"></div>` +
      `<div class="body"><input type="text" class="pinput"/></div>` +
      `<div class="foot"><button class="no">Cancel</button><button class="primary yes">OK</button></div></div>`;
    bd.querySelector(".head")!.textContent = title;
    const input = bd.querySelector<HTMLInputElement>(".pinput")!;
    input.value = initial;
    document.body.appendChild(bd);
    input.focus();
    input.select();
    const done = (v: string | null) => { bd.remove(); resolve(v); };
    bd.querySelector(".yes")!.addEventListener("click", () => done(input.value.trim() || null));
    bd.querySelector(".no")!.addEventListener("click", () => done(null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(input.value.trim() || null);
      if (e.key === "Escape") done(null);
    });
  });
}

function confirmModal(title: string, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = $("modal");
    modal.innerHTML = `<div class="head"></div><div class="body"></div>` +
      `<div class="foot"><button class="no">Cancel</button><button class="primary yes">OK</button></div>`;
    modal.querySelector(".head")!.textContent = title;
    modal.querySelector(".body")!.textContent = text;
    $("modal-backdrop").classList.add("show");
    const done = (v: boolean) => { $("modal-backdrop").classList.remove("show"); resolve(v); };
    modal.querySelector(".yes")!.addEventListener("click", () => done(true));
    modal.querySelector(".no")!.addEventListener("click", () => done(false));
  });
}

function editPromptModal(title: string, info: string, prompt: string): Promise<{ prompt: string; keepBranch: boolean } | null> {
  return new Promise((resolve) => {
    const modal = $("modal");
    modal.innerHTML =
      `<div class="head"></div>` +
      `<div class="body"><div class="info"></div><textarea></textarea>` +
      `<label class="check"><input type="checkbox" class="keep"/> Keep the discarded turns as an inactive branch (instead of deleting them)</label></div>` +
      `<div class="foot"><button class="no">Cancel</button><button class="primary yes">Run again</button></div>`;
    modal.querySelector(".head")!.textContent = title;
    modal.querySelector(".info")!.textContent = info;
    const ta = modal.querySelector("textarea")!;
    ta.value = prompt;
    $("modal-backdrop").classList.add("show");
    const done = (v: { prompt: string; keepBranch: boolean } | null) => {
      $("modal-backdrop").classList.remove("show");
      resolve(v);
    };
    modal.querySelector(".yes")!.addEventListener("click", () => {
      const p = ta.value.trim();
      if (!p) return;
      done({ prompt: p, keepBranch: (modal.querySelector(".keep") as HTMLInputElement).checked });
    });
    modal.querySelector(".no")!.addEventListener("click", () => done(null));
  });
}

// ------------------------------------------------- approval / plan / stage
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function diffHtml(text: string): string {
  return text.split("\n").map((ln) => {
    if (ln.startsWith("+") && !ln.startsWith("+++")) return `<span class="add">${esc(ln)}</span>`;
    if (ln.startsWith("-") && !ln.startsWith("---")) return `<span class="del">${esc(ln)}</span>`;
    if (ln.startsWith("@@")) return `<span class="hunk">${esc(ln)}</span>`;
    return esc(ln);
  }).join("\n");
}

// Inline question panel above the input box (like VS Code Copilot): used for approvals and ask_user.
interface PanelRow {
  label: string;
  desc?: string;
  input?: { placeholder: string; value?: string; required?: boolean };
  select?: string[];
}
interface PanelResult { index: number; text: string; select: string }
interface PanelJob {
  reqId: string;
  title: string;
  question: string;
  detail?: string;
  rows: PanelRow[];
  resolve: (r: PanelResult | null | undefined) => void;
}
const panelQueue: PanelJob[] = [];
let panelCur: PanelJob | null = null;

// resolves: PanelResult = submitted, null = dismissed by the user, undefined = stale (turn ended / duplicate)
function panelEnqueue(job: Omit<PanelJob, "resolve">): Promise<PanelResult | null | undefined> {
  if (panelCur?.reqId === job.reqId || panelQueue.some((j) => j.reqId === job.reqId)) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    panelQueue.push({ ...job, resolve });
    if (!panelCur) panelNext();
  });
}

function panelHide() {
  const host = $("ask-panel");
  host.classList.add("hidden");
  host.classList.remove("ap-collapsed");
  host.innerHTML = "";
}

function panelCancelAll() {
  const cur = panelCur;
  panelCur = null;
  cur?.resolve(undefined);
  panelQueue.splice(0).forEach((j) => j.resolve(undefined));
  panelHide();
}

function panelClose(result: PanelResult | null) {
  const job = panelCur;
  if (!job) return;
  panelCur = null;
  job.resolve(result);
  panelNext();
}

function panelNext() {
  const job = panelQueue.shift();
  if (!job) { panelCur = null; panelHide(); return; }
  panelCur = job;
  switchLeftTab("sessions");
  const host = $("ask-panel");
  host.classList.remove("hidden", "ap-collapsed");
  host.innerHTML =
    `<div class="ap-head"><span class="ap-title"></span>` +
    `<button class="ap-icon ap-close" title="Dismiss (Esc)">✕</button>` +
    `<button class="ap-icon ap-collapse" title="Collapse / expand">⌄</button></div>` +
    `<div class="ap-body"><div class="ap-q"></div><pre class="diff ap-detail"></pre><div class="ap-opts"></div></div>` +
    `<div class="ap-foot"><button class="ap-submit">Submit</button></div>`;
  const title = host.querySelector(".ap-title") as HTMLElement;
  title.textContent = job.title;
  title.title = job.title;
  (host.querySelector(".ap-q") as HTMLElement).textContent = job.question;
  if (!job.question) host.querySelector(".ap-q")!.remove();
  const detail = host.querySelector(".ap-detail") as HTMLElement;
  if (job.detail) detail.innerHTML = job.detail; else detail.remove();

  const optsEl = host.querySelector(".ap-opts") as HTMLElement;
  const rowEls: HTMLElement[] = [];
  const inputs: (HTMLInputElement | null)[] = [];
  const selects: (HTMLSelectElement | null)[] = [];
  let sel = 0;
  const paint = () => rowEls.forEach((el, i) => el.classList.toggle("sel", i === sel));
  const choose = (i: number) => { sel = i; paint(); inputs[i]?.focus(); };
  job.rows.forEach((row, i) => {
    const el = document.createElement("div");
    el.className = "ap-opt";
    const num = document.createElement("span");
    num.className = "ap-num";
    num.textContent = String(i + 1);
    el.appendChild(num);
    let input: HTMLInputElement | null = null;
    let select: HTMLSelectElement | null = null;
    if (row.label) {
      const lb = document.createElement("span");
      lb.className = "ap-label";
      lb.textContent = row.label;
      el.appendChild(lb);
    }
    if (row.desc) {
      const d = document.createElement("span");
      d.className = "ap-desc";
      d.textContent = row.desc;
      el.appendChild(d);
    }
    if (row.input) {
      input = document.createElement("input");
      input.type = "text";
      input.className = "ap-input";
      input.placeholder = row.input.placeholder;
      input.value = row.input.value ?? "";
      input.addEventListener("focus", () => { sel = i; paint(); });
      el.appendChild(input);
    }
    if (row.select) {
      select = document.createElement("select");
      select.className = "ap-select";
      for (const o of row.select) select.add(new Option(o, o));
      el.appendChild(select);
    }
    const check = document.createElement("span");
    check.className = "ap-check";
    check.textContent = "✓";
    el.appendChild(check);
    el.addEventListener("click", (e) => { if (e.target === input || e.target === select) return; choose(i); });
    optsEl.appendChild(el);
    rowEls.push(el);
    inputs.push(input);
    selects.push(select);
  });
  paint();

  const submit = () => {
    const input = inputs[sel];
    const text = input?.value.trim() ?? "";
    if (job.rows[sel].input?.required && !text) { input?.focus(); return; }
    panelClose({ index: sel, text, select: selects[sel]?.value ?? "" });
  };
  host.querySelector(".ap-submit")!.addEventListener("click", submit);
  host.querySelector(".ap-close")!.addEventListener("click", () => panelClose(null));
  host.querySelector(".ap-collapse")!.addEventListener("click", () => {
    const collapsed = host.classList.toggle("ap-collapsed");
    (host.querySelector(".ap-collapse") as HTMLElement).textContent = collapsed ? "⌃" : "⌄";
  });
  host.onkeydown = (e) => {
    const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if (e.key === "Escape") { e.preventDefault(); panelClose(null); }
    else if (e.key === "Enter" && !(e.target instanceof HTMLSelectElement)) { e.preventDefault(); submit(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); choose(Math.min(sel + 1, rowEls.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); choose(Math.max(sel - 1, 0)); }
    else if (!inField && /^[1-9]$/.test(e.key) && Number(e.key) <= rowEls.length) { e.preventDefault(); choose(Number(e.key) - 1); }
  };
  host.focus();
}

async function answerQuietly(reqId: string, response: Record<string, any>) {
  try {
    await call("answer", { req_id: reqId, response });
  } catch { /* the turn was cancelled meanwhile: the question no longer exists */ }
}

async function approvalDialog(req: Record<string, any>): Promise<Record<string, any> | undefined> {
  const what = req.kind === "command" ? "Run command" : req.kind === "network" ? "Network access"
    : req.kind === "mcp" ? "MCP tool" : req.kind === "read" ? "Read sensitive file" : "Write file";
  const rule = String(req.suggested_rule ?? "");
  const rows: PanelRow[] = [{ label: "Allow once" }, { label: "Allow all in this session" }];
  const ruleIdx = rule ? rows.push({
    label: "Allow & remember rule",
    input: { placeholder: "rule", value: rule, required: true },
    select: ["project", "user"],
  }) - 1 : -1;
  rows.push({ label: "Reject", input: { placeholder: "Optional feedback sent to the model" } });
  const r = await panelEnqueue({
    reqId: String(req.req_id), title: what, question: String(req.title ?? ""), detail: diffHtml(req.detail ?? ""), rows,
  });
  if (r === undefined) return undefined;
  if (r === null) return { allow: false };
  if (r.index === 0) return { allow: true };
  if (r.index === 1) return { allow: true, session_approve: true };
  if (r.index === ruleIdx) return { allow: true, remember_rule: r.text, remember_scope: r.select || "project" };
  return { allow: false, feedback: r.text };
}

async function askUserDialog(req: Record<string, any>): Promise<Record<string, any> | undefined> {
  const options: { label: string; description?: string }[] = Array.isArray(req.options) ? req.options : [];
  const rows: PanelRow[] = options.map((o) => ({ label: o.label, desc: o.description }));
  if (req.allow_freeform !== false || !rows.length) {
    rows.push({ label: "", input: { placeholder: "Enter custom answer", required: true } });
  }
  const r = await panelEnqueue({
    reqId: String(req.req_id), title: String(req.header || "Question"), question: String(req.question ?? ""), rows,
  });
  if (r === undefined) return undefined;
  if (r === null) return { dismissed: true };
  if (r.index < options.length) return { answer: options[r.index].label, custom: false };
  return { answer: r.text, custom: true };
}

function stageDialog(report: Record<string, any>): Promise<string> {
  return new Promise((resolve) => {
    const modal = $("modal");
    modal.className = "modal";
    const subs: any[] = report.subtasks ?? [];
    let anyFailed = false;
    const rows = subs.map((s) => {
      const bad = ["failed", "skipped", "cancelled"].includes(s.status);
      anyFailed = anyFailed || bad;
      const cls = bad ? "c-error" : "c-ok";
      return `<div class="${cls} b">${esc(s.id)}  [${esc(s.status ?? "")}]  ${esc(s.title ?? "")}</div>` +
        `<div>${esc(s.summary || "(no summary)")}</div><div>&nbsp;</div>`;
    }).join("");
    modal.innerHTML =
      `<div class="head"></div>` +
      `<div class="body">${rows}` +
      `<div class="b">Files changed so far by this plan:</div><div class="diff"></div></div>` +
      `<div class="foot"><button class="stop">Stop here</button><button class="retry">Retry failed</button><button class="primary cont">Continue</button></div>`;
    modal.querySelector(".head")!.textContent = `Stage ${(report.index ?? 0) + 1}/${report.total ?? 0} finished`;
    modal.querySelector(".diff")!.textContent = (report.changed_files ?? []).join("\n") || "(none)";
    const cont = modal.querySelector(".cont") as HTMLButtonElement;
    cont.textContent = report.is_last ? "Finish" : `Continue to stage ${(report.index ?? 0) + 2}`;
    (modal.querySelector(".retry") as HTMLButtonElement).disabled = !anyFailed;
    $("modal-backdrop").classList.add("show");
    const done = (v: string) => { $("modal-backdrop").classList.remove("show"); resolve(v); };
    modal.querySelector(".cont")!.addEventListener("click", () => done("continue"));
    modal.querySelector(".retry")!.addEventListener("click", () => done("retry"));
    modal.querySelector(".stop")!.addEventListener("click", () => done("stop"));
  });
}

function planDialog(plan: Record<string, any>, typeNames: string[]): Promise<Record<string, any> | null> {
  return new Promise((resolve) => {
    const modal = $("modal");
    modal.className = "modal wide";
    const subs: any[] = ((plan.subtasks ?? []) as any[]).map((s: any) => ({
      id: s.id ?? "", title: s.title ?? "", goal: s.goal ?? "",
      depends_on: (s.depends_on ?? []).join(", "), task_type: s.task_type ?? "general",
      files: (s.files ?? []).join(", "),
    }));
    const opts = typeNames.map((n) => `<option>${esc(n)}</option>`).join("");
    modal.innerHTML =
      `<div class="head"></div>` +
      `<div class="body"><div class="info">The plan below was generated for your goal. Edit, add or remove subtasks, then run it. Subtasks without dependencies between them may run in parallel.</div>` +
      `<table class="plan-table"><thead><tr><th>id</th><th>title</th><th>depends on</th><th>task type</th><th>files</th><th class="goal-cell">goal</th></tr></thead><tbody></tbody></table>` +
      `<div class="table-tools"><button class="add">Add subtask</button><button class="rem">Remove selected</button></div></div>` +
      `<div class="foot"><button class="no">Cancel</button><button class="primary yes">Run plan</button></div>`;
    modal.querySelector(".head")!.textContent = "Review plan";
    const tbody = modal.querySelector("tbody")!;
    subs.forEach((s) => tbody.insertAdjacentHTML("beforeend", planRow(s, opts)));

    function planRow(s: any, o: string): string {
      const sel = o.replace(new RegExp(`<option>${esc(s.task_type)}</option>`), `<option selected>${esc(s.task_type)}</option>`);
      return `<tr><td><input class="c-id" value="${esc(s.id)}"/></td>` +
        `<td><input class="c-title" value="${esc(s.title)}"/></td>` +
        `<td><input class="c-deps" value="${esc(s.depends_on)}"/></td>` +
        `<td><select class="c-type">${sel}</select></td>` +
        `<td><input class="c-files" value="${esc(s.files)}"/></td>` +
        `<td class="goal-cell"><input class="c-goal" value="${esc(s.goal)}"/></td></tr>`;
    }

    modal.querySelector(".add")!.addEventListener("click", () => {
      const n = tbody.rows.length + 1;
      tbody.insertAdjacentHTML("beforeend", planRow({ id: `T${n}`, title: "", goal: "", depends_on: "", task_type: typeNames[0] ?? "general", files: "" }, opts));
    });
    modal.querySelector(".rem")!.addEventListener("click", () => {
      const sel = [...tbody.querySelectorAll("tr.selected")];
      if (sel.length) sel.forEach((tr) => tr.remove());
    });
    tbody.addEventListener("click", (e) => {
      const tr = (e.target as HTMLElement).closest("tr");
      if (!tr) return;
      const was = tr.classList.contains("selected");
      tbody.querySelectorAll("tr.selected").forEach((x) => x.classList.remove("selected"));
      if (!was) tr.classList.add("selected");
    });

    $("modal-backdrop").classList.add("show");
    const done = (v: Record<string, any> | null) => { $("modal-backdrop").classList.remove("show"); resolve(v); };
    modal.querySelector(".no")!.addEventListener("click", () => done(null));
    modal.querySelector(".yes")!.addEventListener("click", () => {
      const out = [...tbody.rows].map((tr) => {
        const g = (c: string) => (tr.querySelector(c) as HTMLInputElement | HTMLSelectElement).value.trim();
        return {
          id: g(".c-id"), title: g(".c-title"),
          depends_on: g(".c-deps") ? g(".c-deps").split(",").map((x) => x.trim()).filter(Boolean) : [],
          task_type: g(".c-type"),
          files: g(".c-files") ? g(".c-files").split(",").map((x) => x.trim()).filter(Boolean) : [],
          goal: g(".c-goal"),
        };
      }).filter((s) => s.id || s.goal);
      done({ goal: plan.goal ?? "", subtasks: out });
    });
  });
}

// ------------------------------------------------------------- settings
const SETTINGS_TIPS: Record<string, string> = {
  effort: "reasoning_effort sent to the server ('default' = send nothing)",
  send_effort: "Send the reasoning_effort request field",
  enable_thinking: "chat_template_kwargs.enable_thinking (blank = server default)",
  token_budget: "thinking_token_budget (vLLM). 0/blank = unset",
  max_think_chars: "Abort thinking and retry without it if it exceeds this many chars. 0 = unlimited",
  extra_body: "JSON merged into the request body, e.g. {\"top_k\": 20}",
  max_tokens: "Server-side context length (cache size). Compression is based on this.",
  compress_threshold: "Compress when usage reaches this fraction (0.95 = 95%)",
  compress_target: "Compress down to this fraction",
  parallelism: "Concurrent sub-agents. Keep 1 for a single-GPU Ollama.",
  bypass_proxy: "Ignore HTTP(S)_PROXY environment variables (LAN server)",
  planner_thinking: "Allow thinking while planning (slower)",
  doc_analysis: "Summarise relevant MODULE.md files before each subtask",
  confirm_each_stage: "Ask for confirmation after every stage",
  prompt_dump: "Write every request sent to the LLM server to a JSON file (Settings > Debug > View dumps)",
  api_key: "Auth key for the LLM server (OpenAI-compatible endpoints). Previously used keys are offered as suggestions; stored locally in this app only.",
  base_url: "The LLM server this app talks to (OpenAI-compatible endpoint). http://127.0.0.1:8000/v1 = a server on this machine (e.g. vLLM); for Ollama use http://127.0.0.1:11434/v1. A remote GPU box: http://&lt;host&gt;:&lt;port&gt;/v1.",
};

// ------------------------------------------------- prompt dumps viewer
async function openDumpsDialog(): Promise<void> {
  const bd = document.createElement("div");
  bd.className = "modal-backdrop stacked show";
  bd.innerHTML =
    `<div class="modal dumps">` +
    `<div class="head">Prompt dumps <span style="font-weight:normal;color:var(--text-soft2)" class="ddir"></span></div>` +
    `<div class="dbody"><div class="dlist"></div><div class="dview"><pre class="muted" style="border:none;background:none;padding:0">select a dump on the left</pre></div></div>` +
    `<div class="foot"><button class="d-refresh">&#10227; Refresh</button><span class="flex1"></span><button class="no">Close</button></div>` +
    `</div>`;
  document.body.appendChild(bd);
  const list = bd.querySelector(".dlist")!;
  const view = bd.querySelector(".dview")!;
  const close = () => bd.remove();
  bd.querySelector(".no")!.addEventListener("click", close);
  bd.addEventListener("click", (e) => { if (e.target === bd) close(); });

  async function load() {
    const r = await call("prompt_dumps", {}, { waitReady: true });
    if (r && r.__error) { list.innerHTML = `<div class="drow">error: ${esc(String(r.__error))}</div>`; return; }
    bd.querySelector(".ddir")!.textContent = r.dir;
    list.innerHTML = "";
    if (!r.files.length) { list.innerHTML = `<div class="drow muted" style="cursor:default">no dumps yet (enable in Settings &gt; Debug)</div>`; return; }
    for (const f of r.files) {
      const row = document.createElement("div");
      row.className = "drow";
      const kb = (f.size / 1024).toFixed(1) + " KB";
      const ts = new Date(f.mtime * 1000).toLocaleString();
      row.innerHTML = `<div class="dname">${esc(f.name)}</div><div class="dmeta">${kb} &middot; ${esc(ts)}</div>`;
      row.addEventListener("click", async () => {
        list.querySelectorAll(".drow").forEach((x) => x.classList.remove("sel"));
        row.classList.add("sel");
        view.innerHTML = `<pre class="muted" style="border:none;background:none;padding:0">loading...</pre>`;
        const c = await call("prompt_dump_content", { name: f.name });
        if (c && c.__error) { view.innerHTML = `<pre style="border:none">error: ${esc(String(c.__error))}</pre>`; return; }
        view.innerHTML = `<pre></pre>`;
        view.querySelector("pre")!.textContent = c.text;
      });
      list.appendChild(row);
    }
  }
  bd.querySelector(".d-refresh")!.addEventListener("click", () => void load());
  void load();
}

async function settingsDialog(initialTab = "model"): Promise<boolean> {
  // The dialog must open IMMEDIATELY even when the backend is down: the
  // Remote server tab is main-process state (no RPC needed) and is exactly
  // what the user wants to fix when the connection is broken. So: short
  // timeout on the RPCs that need a live backend (2s) - if the backend is up
  // they answer instantly, if it is down the dialog opens with local state
  // and the Server/Model fields fall back to the built-in defaults.
  const strategiesR = await call("context_strategies", {}, { waitReady: true, timeoutMs: 2000 });
  const strategies: string[] = (strategiesR && !strategiesR.__error) ? strategiesR.strategies : ["summarize", "truncate"];
  // no project open yet: fall back to the built-in defaults so the Server /
  // Model fields are editable (saving then writes the user-wide config only)
  let base = S.config;
  if (!base) {
    const d = await call("default_config", {}, { waitReady: true, timeoutMs: 2000 });
    base = (d && !d.__error) ? d : null;
  }
  return new Promise((resolve) => {
    const modal = $("modal");
    modal.className = "modal wide anchored";
    modal.innerHTML =
      `<div class="head">Settings</div>` +
      `<div class="settings">` +
      `<div class="tabs"><button data-p="model"${initialTab === "model" ? " class=\"active\"" : ""}>Model</button><button data-p="context"${initialTab === "context" ? " class=\"active\"" : ""}>Context &amp; agent</button><button data-p="prompts"${initialTab === "prompts" ? " class=\"active\"" : ""}>Task prompts</button><button data-p="approval"${initialTab === "approval" ? " class=\"active\"" : ""}>Approval</button><button data-p="connection"${initialTab === "connection" ? " class=\"active\"" : ""}>Remote server</button><button data-p="appearance"${initialTab === "appearance" ? " class=\"active\"" : ""}>Appearance</button><button data-p="debug"${initialTab === "debug" ? " class=\"active\"" : ""}>Debug</button><button class="close-x" title="Close">&#10005;</button></div>` +
      `<div class="pages"><div class="page${initialTab === "model" ? " active" : ""}" data-p="model"></div><div class="page${initialTab === "context" ? " active" : ""}" data-p="context"></div><div class="page${initialTab === "prompts" ? " active" : ""}" data-p="prompts"></div><div class="page${initialTab === "approval" ? " active" : ""}" data-p="approval"></div><div class="page${initialTab === "connection" ? " active" : ""}" data-p="connection"></div><div class="page${initialTab === "appearance" ? " active" : ""}" data-p="appearance"></div><div class="page${initialTab === "debug" ? " active" : ""}" data-p="debug"></div></div>` +
      `</div>` +
      `<div class="foot"><button class="no">Cancel</button><button class="primary yes">Save</button></div>`;

    const cfg = JSON.parse(JSON.stringify(base ?? {}));
    const choices: Record<string, string[]> = {
      provider: ["openai_compat", "ollama"],
      algorithm: strategies,
    };
    const skip = new Set(["project_root"]);
    const dirtyPrompts = new Map<string, string>();

    function fieldHtml(sec: string, key: string, val: any): string {
      if (skip.has(key)) return "";
      const tip = SETTINGS_TIPS[key] ? `<span class="tip">${SETTINGS_TIPS[key]}</span>` : "";
      const label = `<span class="lbl">${key}${tip}</span>`;
      const opts = choices[key];
      if (opts) {
        return `<div class="field">${label}<select data-s="${sec}" data-k="${key}">` +
          opts.map((o) => `<option${o === val ? " selected" : ""}>${o}</option>`).join("") + `</select></div>`;
      }
      if (typeof val === "boolean") {
        return `<div class="field">${label}<input type="checkbox" data-s="${sec}" data-k="${key}"${val ? " checked" : ""}/></div>`;
      }
      if (val === null || val === undefined) {
        return `<div class="field">${label}<input type="text" data-s="${sec}" data-k="${key}" data-null="1" value=""/></div>`;
      }
      if (typeof val === "number") {
        return `<div class="field">${label}<input type="number" step="any" data-s="${sec}" data-k="${key}" value="${val}"/></div>`;
      }
      if (typeof val === "object") {
        // extra_body (dict) / prompt_dirs (list)
        const text = Array.isArray(val) ? val.join(", ") : JSON.stringify(val);
        return `<div class="field">${label}<input type="text" data-s="${sec}" data-k="${key}" data-obj="1" value="${esc(text)}"/></div>`;
      }
      return `<div class="field">${label}<input type="text" data-s="${sec}" data-k="${key}" value="${esc(String(val))}"/></div>`;
    }

    function group(sec: string, title: string): string {
      const body = Object.entries(cfg[sec] ?? {}).map(([k, v]) => fieldHtml(sec, k, v)).join("");
      return `<fieldset class="grp"><legend>${title}</legend>${body}</fieldset>`;
    }

    const modelPage = modal.querySelector<HTMLElement>('.page[data-p="model"]')!;
    modelPage.innerHTML =
      group("server", "Server") +
      `<div class="btnrow"><button class="test">Test connection / list models</button></div>` +
      `<div class="msg"></div>` +
      group("thinking", "Thinking") +
      group("sampling", "Sampling");

    // ---- model history (per provider, localStorage)
    const MODEL_HIST_KEY = "agent_ts_gui.model_history";
    function modelHistory(): Record<string, string[]> {
      try { return JSON.parse(localStorage.getItem(MODEL_HIST_KEY) ?? "{}"); } catch { return {}; }
    }
    function recordModel(provider: string, model: string) {
      if (!model) return;
      const h = modelHistory();
      const list = h[provider] ?? [];
      h[provider] = [model, ...list.filter((x) => x !== model)].slice(0, 50);
      try { localStorage.setItem(MODEL_HIST_KEY, JSON.stringify(h)); } catch { /* ignore */ }
    }
    // ---- model dropdown: starts empty; the list is fetched from the
    // configured base_url when the user opens the dropdown
    // guard: if the config has not loaded yet (Settings opened before the
    // project finished opening) the server fields may be absent - skip the
    // dropdown instead of crashing the whole dialog
    const modelInput = modelPage.querySelector<HTMLElement>('[data-s="server"][data-k="model"]');
    let modelSel: HTMLSelectElement | null = null;
    let modelLoadedFor = ""; // base_url the options were fetched for
    function populateModelSel(models: string[]): void {
      if (!modelSel) return;
      const cur = modelSel.value;
      modelSel.innerHTML = "";
      modelSel.appendChild(new Option("(select a model…)", ""));
      for (const x of models) modelSel.appendChild(new Option(x, x));
      if (cur && models.includes(cur)) modelSel.value = cur;
    }
    async function loadModelList(): Promise<void> {
      if (!modelSel) return;
      const m = modelPage.querySelector(".msg") as HTMLElement;
      const url = (modelPage.querySelector<HTMLInputElement>('[data-s="server"][data-k="base_url"]')?.value ?? "").trim();
      if (url === modelLoadedFor) return; // already loaded for this server
      m.className = "msg"; m.textContent = "Loading model list…";
      const r = await call("test_connection", { config: collect() });
      if (r && r.__error) {
        showMsg(modelPage, false, `Cannot reach the model server at ${url || "(no base url set)"}: ${String(r.__error)}`);
        return;
      }
      const models: string[] = r.models ?? [];
      const provider = collect().server?.provider ?? "";
      for (const x of models) recordModel(provider, x);
      populateModelSel(models);
      modelLoadedFor = url;
      m.className = "msg"; m.textContent = "";
    }
    if (modelInput) {
      const cur = (modelInput as HTMLInputElement).value;
      const sel = modelPage.ownerDocument.createElement("select");
      sel.dataset.s = "server";
      sel.dataset.k = "model";
      modelInput.replaceWith(sel);
      modelSel = sel;
      sel.appendChild(new Option("(click to load from server…)", ""));
      if (cur) sel.appendChild(new Option(cur, cur)); // keep the saved value selectable
      sel.value = cur || "";
      sel.addEventListener("click", () => void loadModelList());
      sel.addEventListener("focus", () => void loadModelList());
      // a changed base_url invalidates the loaded list
      modelPage.querySelector<HTMLInputElement>('[data-s="server"][data-k="base_url"]')
        ?.addEventListener("change", () => { modelLoadedFor = ""; });
    }

    // ---- base_url history (localStorage): quick-pick previously used URLs
    const BASE_URL_HIST_KEY = "agent_ts_gui.base_url_history";
    function baseUrlHistory(): string[] {
      try { return JSON.parse(localStorage.getItem(BASE_URL_HIST_KEY) ?? "[]"); } catch { return []; }
    }
    function recordBaseUrl(url: string) {
      if (!url) return;
      const list = baseUrlHistory();
      localStorage.setItem(BASE_URL_HIST_KEY, JSON.stringify([url, ...list.filter((x) => x !== url)].slice(0, 50)));
    }
    const baseUrlInput = modelPage.querySelector<HTMLInputElement>('[data-s="server"][data-k="base_url"]');
    if (baseUrlInput) {
      baseUrlInput.setAttribute("list", "baseurl-dl");
      const urlDl = modelPage.ownerDocument.createElement("datalist");
      urlDl.id = "baseurl-dl";
      modelPage.appendChild(urlDl);
      const cur = baseUrlInput.value.trim();
      const opts = cur && !baseUrlHistory().includes(cur) ? [cur, ...baseUrlHistory()] : baseUrlHistory();
      urlDl.innerHTML = opts.map((u) => `<option value="${esc(u)}"></option>`).join("");
    }

    // ---- api_key history (localStorage): quick-pick previously used keys
    const API_KEY_HIST_KEY = "agent_ts_gui.api_key_history";
    function apiKeyHistory(): string[] {
      try { return JSON.parse(localStorage.getItem(API_KEY_HIST_KEY) ?? "[]"); } catch { return []; }
    }
    function recordApiKey(key: string) {
      if (!key) return;
      const list = apiKeyHistory();
      localStorage.setItem(API_KEY_HIST_KEY, JSON.stringify([key, ...list.filter((x) => x !== key)].slice(0, 50)));
    }
    const apiKeyInput = modelPage.querySelector<HTMLInputElement>('[data-s="server"][data-k="api_key"]');
    if (apiKeyInput) {
      apiKeyInput.setAttribute("list", "apikey-dl");
      const keyDl = modelPage.ownerDocument.createElement("datalist");
      keyDl.id = "apikey-dl";
      modelPage.appendChild(keyDl);
      const cur = apiKeyInput.value.trim();
      const opts = cur && !apiKeyHistory().includes(cur) ? [cur, ...apiKeyHistory()] : apiKeyHistory();
      keyDl.innerHTML = opts.map((k) => `<option value="${esc(k)}"></option>`).join("");
    }

    const ctxPage = modal.querySelector<HTMLElement>('.page[data-p="context"]')!;
    ctxPage.innerHTML =
      group("context", "Context / compression") +
      `<div class="btnrow"><button class="detect">Detect server context length and use it for max_tokens</button></div>` +
      `<div class="msg"></div>` +
      group("agent", "Agent") +
      group("orchestrator", "Subtask planning") +
      group("paths", "Paths");

    // ---- prompts tab
    const pPage = modal.querySelector<HTMLElement>('.page[data-p="prompts"]')!;
    pPage.innerHTML =
      `<div class="toprow"><select class="ptype"></select><button class="pnew">New type...</button><button class="prevert">Revert to default</button><button class="pview" title="Show the full system prompt that will be sent for this task type">View system prompt</button></div>` +
      `<textarea class="code"></textarea>` +
      `<div class="tip" style="font-size:11px;color:var(--text-soft2);margin-top:6px">Front-matter keys: name, description, keywords, globs, effort, tools. Saved to the user prompts folder; a project can override in &lt;project&gt;/.agent/prompts/.</div>`;
    const pType = pPage.querySelector(".ptype") as HTMLSelectElement;
    const pEdit = pPage.querySelector("textarea") as HTMLTextAreaElement;
    let pCurrent: string | null = null;

    async function pSwitch(name: string) {
      if (pCurrent && pEdit.value !== (dirtyPrompts.get(pCurrent) ?? (await pText(pCurrent)))) dirtyPrompts.set(pCurrent, pEdit.value);
      pCurrent = name;
      pEdit.value = dirtyPrompts.get(name) ?? (await pText(name));
    }
    async function pText(name: string): Promise<string> {
      const r = await call("prompt_source", { name });
      return r && r.__error ? "" : r.text;
    }
    async function pLoad() {
      const names = ["base", ...S.taskTypes];
      pType.innerHTML = names.map((n) => `<option>${esc(n)}</option>`).join("");
      await pSwitch(names[0]);
    }
    pType.addEventListener("change", () => void pSwitch(pType.value));
    pPage.querySelector(".pnew")!.addEventListener("click", async () => {
      const name = window.prompt("New task type name (letters, digits, _):");
      if (!name || !/^[A-Za-z0-9_]+$/.test(name)) return;
      if (!dirtyPrompts.has(name)) {
        dirtyPrompts.set(name, `---\nname: ${name}\ndescription: \nkeywords: \nglobs: \neffort: medium\n---\nTask type: ${name}.\n`);
      }
      if (![...pType.options].some((o) => o.value === name)) pType.add(new Option(name, name));
      pType.value = name;
      await pSwitch(name);
    });
    pPage.querySelector(".prevert")!.addEventListener("click", async () => {
      if (!pCurrent) return;
      dirtyPrompts.delete(pCurrent);
      await call("revert_prompt", { name: pCurrent });
      pEdit.value = await pText(pCurrent);
    });
    // read-only view of the full system prompt that will be sent for the
    // selected task type (replaces the old toolbar "System prompt" button)
    pPage.querySelector(".pview")!.addEventListener("click", async () => {
      const taskType = pCurrent ?? "general";
      const r = await call("system_prompt", { task_type: taskType });
      if (r && r.__error) { chat.line(`\n[error] ${r.__error}`, "c-error"); return; }
      const bd = document.createElement("div");
      bd.className = "modal-backdrop stacked show";
      bd.innerHTML =
        `<div class="modal wide"><div class="head">System prompt (${esc(taskType)})</div>` +
        `<div class="body"><pre class="diff" style="max-height:60vh"></pre></div>` +
        `<div class="foot"><button class="primary yes">Close</button></div></div>`;
      bd.querySelector("pre")!.textContent = r.text;
      document.body.appendChild(bd);
      bd.querySelector(".yes")!.addEventListener("click", () => bd.remove());
    });
    void pLoad();

    // ---- approval tab
    const aPage = modal.querySelector<HTMLElement>('.page[data-p="approval"]')!;
    aPage.innerHTML = `<div class="apath" style="font-size:12px;color:var(--text-soft);margin-bottom:6px"></div><textarea class="code"></textarea>`;
    const aEdit = aPage.querySelector("textarea") as HTMLTextAreaElement;
    let approvalText = "";
    void (async () => {
      const r = await call("approval_policy");
      if (r && r.__error) return;
      approvalText = r.text;
      aEdit.value = r.text;
      aPage.querySelector(".apath")!.textContent = `User-wide approval policy: ${r.path} (projects can add rules in <project>/.agent/approval.toml)`;
    })();

    // ---- connection tab (GUI <-> agent server; independent of the LLM "server" above)
    const cPage = modal.querySelector<HTMLElement>('.page[data-p="connection"]')!;
    cPage.innerHTML =
      `<fieldset class="grp"><legend>Remote server</legend>` +
      `<div class="field"><span class="lbl">mode</span><select class="c-mode"><option value="local">local (this machine, auto-started)</option><option value="remote">remote (coder-agent-server on another machine)</option><option value="ssh">ssh (tunnel to a remote machine)</option></select></div>` +
      `<div class="c-direct">` +
      `<div class="field"><span class="lbl">host</span><input type="text" class="c-host"/></div>` +
      `<div class="field"><span class="lbl">port</span><input type="number" class="c-port"/></div>` +
      `</div>` +
      `<div class="c-sshgrp" style="display:none">` +
      `<div class="c-hosts"></div>` +
      `<div class="btnrow" style="margin-top:4px"><button class="c-host-add">Add host</button><button class="c-host-edit" disabled>Edit</button><button class="c-host-del" disabled>Remove</button></div>` +
      `<div class="c-host-form" style="display:none">` +
      `<div class="field"><span class="lbl">name</span><input type="text" class="hf-name" placeholder="e.g. devbox"/></div>` +
      `<div class="field"><span class="lbl">user</span><input type="text" class="hf-user" placeholder="ywang2"/></div>` +
      `<div class="field"><span class="lbl">host</span><input type="text" class="hf-host" placeholder="10.112.106.102"/></div>` +
      `<div class="field"><span class="lbl">ssh port</span><input type="number" class="hf-port" value="22"/></div>` +
      `<div class="field"><span class="lbl">agent port</span><input type="number" class="hf-rport" value="8931" title="coder-agent-server port on that machine"/></div>` +
      `<div class="field"><span class="lbl">key file</span><input type="text" class="hf-key" placeholder="optional, empty = ssh agent"/></div>` +
      `<div class="btnrow"><button class="hf-save primary">Save host</button><button class="hf-cancel">Cancel</button></div>` +
      `</div>` +
      `<div class="tip" style="font-size:11px;color:var(--text-soft2)">Select a host, then Apply &amp; reconnect (a password window follows if the server asks). Hosts are saved in this app's user data.</div>` +
      `</div>` +
      `<div class="field"><span class="lbl">token</span><input type="text" class="c-token" placeholder="shared secret (server started with --token)"/></div>` +
      `</fieldset>` +
      `<div class="btnrow"><button class="c-apply">Apply &amp; reconnect</button></div>` +
      `<div class="msg"></div>` +
      `<div class="tip" style="font-size:11px;color:var(--text-soft2)">Local mode: the backend runs on this machine and is started automatically. ` +
      `Remote mode: run "coder-agent-server --host 0.0.0.0 --port &lt;port&gt; --token &lt;secret&gt;" on the server machine, ` +
      `then connect here. SSH mode: the app opens "ssh -N -L &lt;local&gt;:127.0.0.1:&lt;server port&gt; &lt;user&gt;@&lt;host&gt;" and connects through it, ` +
      `so the server only needs to listen on loopback (no exposed port, no firewall changes; password or key login). ` +
      `One server serves one GUI; the project paths are on the server machine. ` +
      `The connection is saved in this app's user data and used at next start.</div>`;
    // ---- ssh host list (named hosts; the selected one is used by Apply & reconnect)
    let sshHosts: SshHost[] = [];
    let selHost = ""; // name of the selected host in the list
    const hostsBox = cPage.querySelector(".c-hosts") as HTMLElement;
    const hostForm = cPage.querySelector(".c-host-form") as HTMLElement;
    function hostRow(h: SshHost): string {
      return `<div class="c-host-row${h.name === selHost ? " sel" : ""}" data-n="${esc(h.name)}">` +
        `<span class="c-host-name">${esc(h.name)}</span>` +
        `<span class="c-host-meta">${esc(h.user)}@${esc(h.host)}${h.port !== 22 ? ":" + h.port : ""} &middot; agent port ${h.remotePort}${h.identity ? " &middot; key" : ""}</span></div>`;
    }
    function renderHosts() {
      hostsBox.innerHTML = sshHosts.length
        ? sshHosts.map(hostRow).join("")
        : `<div class="c-host-row muted" style="cursor:default">no hosts yet &mdash; click "Add host"</div>`;
      (cPage.querySelector(".c-host-edit") as HTMLButtonElement).disabled = !selHost;
      (cPage.querySelector(".c-host-del") as HTMLButtonElement).disabled = !selHost;
    }
    function fillHostForm(h: SshHost | null) {
      (cPage.querySelector(".hf-name") as HTMLInputElement).value = h?.name ?? "";
      (cPage.querySelector(".hf-user") as HTMLInputElement).value = h?.user ?? "";
      (cPage.querySelector(".hf-host") as HTMLInputElement).value = h?.host ?? "";
      (cPage.querySelector(".hf-port") as HTMLInputElement).value = String(h?.port ?? 22);
      (cPage.querySelector(".hf-rport") as HTMLInputElement).value = String(h?.remotePort ?? 8931);
      (cPage.querySelector(".hf-key") as HTMLInputElement).value = h?.identity ?? "";
    }
    async function persistHosts(): Promise<boolean> {
      const r = await window.api.sshHostsSave({ hosts: sshHosts, active: selHost || null });
      if (!r.ok) { showMsg(cPage, false, String(r.error)); return false; }
      return true;
    }
    let editingName = ""; // "" = adding a new host
    cPage.querySelector(".c-host-add")!.addEventListener("click", () => {
      editingName = "";
      fillHostForm(null);
      hostForm.style.display = "";
    });
    cPage.querySelector(".hf-cancel")!.addEventListener("click", () => { hostForm.style.display = "none"; });
    cPage.querySelector(".hf-save")!.addEventListener("click", async () => {
      const name = (cPage.querySelector(".hf-name") as HTMLInputElement).value.trim() || "host";
      const user = (cPage.querySelector(".hf-user") as HTMLInputElement).value.trim();
      const host = (cPage.querySelector(".hf-host") as HTMLInputElement).value.trim();
      if (!user || !host) { showMsg(cPage, false, "user and host are required"); return; }
      const h: SshHost = { name, user, host,
        port: Number((cPage.querySelector(".hf-port") as HTMLInputElement).value) || 22,
        remotePort: Number((cPage.querySelector(".hf-rport") as HTMLInputElement).value) || 8931,
        identity: (cPage.querySelector(".hf-key") as HTMLInputElement).value.trim() };
      const i = sshHosts.findIndex((x) => x.name === editingName);
      if (i >= 0) {
        if (sshHosts.some((x) => x.name === name && x.name !== editingName)) { showMsg(cPage, false, "a host with this name already exists"); return; }
        sshHosts[i] = h;
      } else {
        if (sshHosts.some((x) => x.name === name)) { showMsg(cPage, false, "a host with this name already exists"); return; }
        sshHosts.push(h);
      }
      selHost = name;
      hostForm.style.display = "none";
      if (!(await persistHosts())) return;
      renderHosts();
    });
    cPage.querySelector(".c-host-edit")!.addEventListener("click", () => {
      const h = sshHosts.find((x) => x.name === selHost);
      if (!h) return;
      editingName = h.name;
      fillHostForm(h);
      hostForm.style.display = "";
    });
    cPage.querySelector(".c-host-del")!.addEventListener("click", async () => {
      const h = sshHosts.find((x) => x.name === selHost);
      if (!h) return;
      if (!confirm(`Remove host "${h.name}"?`)) return;
      sshHosts = sshHosts.filter((x) => x.name !== selHost);
      selHost = "";
      if (!(await persistHosts())) return;
      renderHosts();
    });
    hostsBox.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest(".c-host-row") as HTMLElement | null;
      if (!row || !row.dataset.n) return;
      selHost = row.dataset.n;
      renderHosts();
    });
    void (async () => {
      const c = await window.api.getConnection();
      (cPage.querySelector(".c-mode") as HTMLSelectElement).value = c.mode;
      (cPage.querySelector(".c-host") as HTMLInputElement).value = c.host;
      (cPage.querySelector(".c-port") as HTMLInputElement).value = String(c.port);
      (cPage.querySelector(".c-token") as HTMLInputElement).value = c.token;
      const l = await window.api.sshHostsList();
      sshHosts = l.hosts;
      selHost = l.active ?? "";
      renderHosts();
      syncConnFields(cPage);
    })();
    // show/hide the direct host:port vs ssh target fields per mode
    function syncConnFields(page: HTMLElement) {
      const mode = (page.querySelector(".c-mode") as HTMLSelectElement).value;
      (page.querySelector(".c-direct") as HTMLElement).style.display = mode === "remote" ? "" : "none";
      (page.querySelector(".c-sshgrp") as HTMLElement).style.display = mode === "ssh" ? "" : "none";
    }
    (cPage.querySelector(".c-mode") as HTMLSelectElement).addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (v === "local") (cPage.querySelector(".c-host") as HTMLInputElement).value = "127.0.0.1";
      syncConnFields(cPage);
    });
    cPage.querySelector(".c-apply")!.addEventListener("click", async () => {
      const m = cPage.querySelector(".msg") as HTMLElement;
      const btn = cPage.querySelector(".c-apply") as HTMLButtonElement;
      btn.disabled = true;
      m.className = "msg"; m.textContent = "Reconnecting...";
      const mode = (cPage.querySelector(".c-mode") as HTMLSelectElement).value as "local" | "remote" | "ssh";
      if (mode === "ssh") {
        const sel = sshHosts.find((x) => x.name === selHost);
        if (!sel) { showMsg(cPage, false, "Select an SSH host first (Add host, then click it in the list)."); return; }
        m.textContent = "Connecting (a password window follows if the server asks)...";
        const sr = await window.api.sshConnect({
          host: sel,
          token: (cPage.querySelector(".c-token") as HTMLInputElement).value,
          root: S.root,
        });
        btn.disabled = false;
        if (!sr.ok) {
          if (sr.error === "cancelled") { m.textContent = ""; return; }
          showMsg(cPage, false, String(sr.error));
          return;
        }
        showMsg(cPage, true, `Connected to ${sr.url}. The current project will be reopened.`);
        void refreshRemoteLabel();
        setTimeout(() => done(false), 400);
        return;
      }
      const r = await window.api.setConnection({
        mode,
        host: (cPage.querySelector(".c-host") as HTMLInputElement).value.trim() || "127.0.0.1",
        port: Number((cPage.querySelector(".c-port") as HTMLInputElement).value) || 8931,
        token: (cPage.querySelector(".c-token") as HTMLInputElement).value,
        // the project currently open: the new local backend is started with it
        root: S.root,
      });
      btn.disabled = false;
      if (!r.ok) { showMsg(cPage, false, String(r.error)); return; }
      if (r.reconnected) {
        showMsg(cPage, true, `Connected to ${r.url}. The current project will be reopened.`);
      } else {
        showMsg(cPage, true, "No change.");
      }
      // close the dialog: the connection is applied and saved (or unchanged)
      void refreshRemoteLabel();
      setTimeout(() => done(false), r.reconnected ? 400 : 1200);
    });

    // ---- appearance tab (GUI-local; applied immediately, persisted in localStorage)
    const apPage = modal.querySelector<HTMLElement>('.page[data-p="appearance"]')!;
    apPage.innerHTML =
      `<fieldset class="grp"><legend>Theme</legend>` +
      `<div class="field"><span class="lbl">theme</span><select class="theme-sel" style="flex:1;min-width:0">` +
      THEMES.map((t) => `<option value="${t.id}">${t.label}</option>`).join("") +
      `</select></div>` +
      `</fieldset>` +
      `<div class="tip" style="font-size:11px;color:var(--text-soft2)">Applies immediately and is remembered for the next start. ` +
      `Light = the original look, Dark = VS Code style, Solarized Light = warm cream tones.</div>`;
    const themeSel = apPage.querySelector(".theme-sel") as HTMLSelectElement;
    themeSel.value = currentTheme();
    themeSel.addEventListener("change", () => {
      const id = themeSel.value as ThemeId;
      applyTheme(id);
      localStorage.setItem(THEME_KEY, id);
    });

    // ---- debug tab (prompt dumps: every request sent to the LLM server)
    const dPage = modal.querySelector<HTMLElement>('.page[data-p="debug"]')!;
    dPage.innerHTML =
      group("debug", "Prompt dump") +
      `<div class="btnrow"><button class="d-view">View dumps</button><button class="d-clear">Clear all</button></div>` +
      `<div class="dpath" style="font-size:12px;color:var(--text-soft);margin-bottom:6px"></div>` +
      `<div class="msg"></div>` +
      `<div class="tip" style="font-size:11px;color:var(--text-soft2)">When enabled, every request sent to the LLM server ` +
      `(full messages, tools, sampling params) is written to a JSON file in the dump directory. ` +
      `Files are numbered in call order and labelled with the agent (main / planner / sub:N). ` +
      `The switch takes effect after Save.</div>`;
    void (async () => {
      const r = await call("prompt_dumps", {}, { waitReady: true });
      if (r && !r.__error) (dPage.querySelector(".dpath") as HTMLElement).textContent = `Dump directory: ${r.dir}`;
    })();
    dPage.querySelector(".d-view")!.addEventListener("click", () => void openDumpsDialog());
    // standalone confirm: confirmModal() reuses #modal and would destroy this dialog
    dPage.querySelector(".d-clear")!.addEventListener("click", () => {
      const m = dPage.querySelector(".msg") as HTMLElement;
      const bd = document.createElement("div");
      bd.className = "modal-backdrop stacked show";
      bd.innerHTML = `<div class="modal prompt"><div class="head">Clear prompt dumps</div>` +
        `<div class="body">Delete all dump files?</div>` +
        `<div class="foot"><button class="no">Cancel</button><button class="primary yes">Clear</button></div></div>`;
      document.body.appendChild(bd);
      const done = () => bd.remove();
      bd.querySelector(".no")!.addEventListener("click", done);
      bd.querySelector(".yes")!.addEventListener("click", async () => {
        done();
        const r = await call("clear_prompt_dumps");
        if (r && r.__error) { m.className = "msg err"; m.textContent = String(r.__error); return; }
        m.className = "msg ok"; m.textContent = `Deleted ${r.deleted} file(s).`;
      });
    });

    // ---- tabs
    modal.querySelectorAll(".settings .tabs button[data-p]").forEach((b) => {
      b.addEventListener("click", () => {
        modal.querySelectorAll(".settings .tabs button[data-p]").forEach((x) => x.classList.remove("active"));
        (b as HTMLElement).classList.add("active");
        const name = (b as HTMLElement).dataset.p!;
        modal.querySelectorAll(".settings .page").forEach((pg) => pg.classList.toggle("active", (pg as HTMLElement).dataset.p === name));
        (modal.querySelector(".settings .pages") as HTMLElement).scrollTop = 0;
      });
    });

    // ---- collect / save
    function collect(): Record<string, any> {
      const out: Record<string, any> = JSON.parse(JSON.stringify(cfg));
      modal.querySelectorAll<HTMLElement>("[data-s]").forEach((el) => {
        const anyEl = el as HTMLInputElement & HTMLSelectElement;
        const sec = anyEl.dataset.s!, k = anyEl.dataset.k!;
        let v: any;
        if ((anyEl as HTMLInputElement).type === "checkbox") v = (anyEl as HTMLInputElement).checked;
        else if (anyEl.dataset.obj === "1") {
          const t = (anyEl as HTMLInputElement).value.trim();
          const base = cfg[sec]?.[k];
          if (!t) v = Array.isArray(base) ? [] : {};
          else if (Array.isArray(base)) v = t.split(",").map((x) => x.trim()).filter(Boolean);
          else v = JSON.parse(t);
        } else if (anyEl.dataset.null === "1") {
          const t = (anyEl as HTMLInputElement).value.trim();
          if (!t) v = null;
          else if (!isNaN(Number(t))) v = Number(t);
          else v = t;
        } else if (typeof cfg[sec]?.[k] === "number") {
          const t = (anyEl as HTMLInputElement).value.trim();
          v = t === "" ? cfg[sec][k] : Number(t);
        } else v = (anyEl as HTMLInputElement).value;
        out[sec] = out[sec] ?? {};
        out[sec][k] = v;
      });
      return out;
    }

    function showMsg(page: HTMLElement, ok: boolean, text: string) {
      const m = page.querySelector(".msg") as HTMLElement;
      m.className = "msg " + (ok ? "ok" : "err");
      m.textContent = text;
    }

    modelPage.querySelector(".test")!.addEventListener("click", async () => {
      const m = modelPage.querySelector(".msg") as HTMLElement;
      m.className = "msg"; m.textContent = "Testing...";
      const r = await call("test_connection", { config: collect() });
      if (r && r.__error) { showMsg(modelPage, false, String(r.__error)); return; }
      const c = collect();
      const provider = c.server?.provider ?? "";
      recordBaseUrl(c.server?.base_url ?? "");
      recordApiKey(c.server?.api_key ?? "");
      for (const m of r.models ?? []) recordModel(provider, m);
      populateModelSel(r.models ?? []);
      modelLoadedFor = c.server?.base_url ?? "";
      const vision = r.vision === false ? "\n\n⚠ This model does NOT accept images (text-only)."
        : r.vision === true ? "\n\n✓ This model accepts images." : "";
      showMsg(modelPage, true, `Models:\n${(r.models ?? []).join("\n")}\n\n${r.context_text ?? ""}${vision}`);
    });
    ctxPage.querySelector(".detect")!.addEventListener("click", async () => {
      const m = ctxPage.querySelector(".msg") as HTMLElement;
      m.className = "msg"; m.textContent = "Detecting...";
      const r = await call("test_connection", { config: collect() });
      if (r && r.__error) { showMsg(ctxPage, false, String(r.__error)); return; }
      const info = r.context ?? {};
      if (info.loaded) {
        cfg.context.max_tokens = info.loaded;
        const inp = ctxPage.querySelector('[data-s="context"][data-k="max_tokens"]') as HTMLInputElement;
        inp.value = String(info.loaded);
        showMsg(ctxPage, true, `${r.context_text ?? ""}\n\ncontext.max_tokens set to ${info.loaded.toLocaleString()}.`);
      } else {
        showMsg(ctxPage, false, r.context_text ?? "could not detect server context length");
      }
    });

    $("modal-backdrop").classList.add("show");
    settingsOpen = true;
    const done = (saved: boolean) => {
      $("modal-backdrop").classList.remove("show");
      settingsOpen = false;
      resolve(saved);
      // a connection switch applied in the dialog may have reconnected the
      // backend while it was open: the global backend-url listener deferred
      // the project re-open (it would have wiped the views under the dialog)
      if (reopenPending) {
        reopenPending = false;
        void (async () => {
          const r = S.root || (await resolveProjectRoot());
          if (r) await openProject(r);
        })();
      }
    };
    modal.querySelector(".no")!.addEventListener("click", () => done(false));
    modal.querySelector(".close-x")!.addEventListener("click", () => done(false));
    modal.querySelector(".yes")!.addEventListener("click", async () => {
      // stash the prompt editor
      if (pCurrent) dirtyPrompts.set(pCurrent, pEdit.value);
      const btn = modal.querySelector(".yes") as HTMLButtonElement;
      btn.disabled = true;
      try {
        const r = await call("save_config", { config: collect() });
        if (r && r.__error) throw new Error(String(r.__error));
        for (const [name, text] of dirtyPrompts) await call("save_prompt", { name, text });
        if (aEdit.value !== approvalText) {
          const ar = await call("save_approval_policy", { text: aEdit.value });
          if (ar && ar.__error) throw new Error("approval policy: " + ar.__error);
          S.approvalPolicy = aEdit.value;
        }
        S.config = collect();
        recordModel(S.config.server?.provider ?? "", S.config.server?.model ?? "");
        recordBaseUrl(S.config.server?.base_url ?? "");
        recordApiKey(S.config.server?.api_key ?? "");
        S.taskTypes = r.task_types ?? S.taskTypes;
        S.effort = S.config.thinking?.effort ?? S.effort;
        S.ctxMax = S.config.context?.max_tokens ?? S.ctxMax;
        S.compressThreshold = S.config.context?.compress_threshold ?? 0.95;
        S.compressTarget = S.config.context?.compress_target ?? 0.5;
        refreshEffortLabel();
        reloadTaskTypes();
        refreshModelLabel();
        refreshApprovalLabel();
        setCtxBar(0, S.ctxMax, false);
        refreshContextEstimate();
        refreshServerInfo();
        done(true);
      } catch (e: any) {
        showMsg(modelPage, false, String(e?.message ?? e));
        btn.disabled = false;
      }
    });
  });
}

// ------------------------------------------------- turn actions (rewind / edit)
async function impactText(turnId: string): Promise<string> {
  const r = await call("rewind_impact", { turn_id: turnId });
  if (r && r.__error) return r.__error;
  let txt = `${r.turns} turn(s) will be discarded.\n`;
  txt += "Files restored to their earlier state:\n  " + (r.files.length ? r.files.join("\n  ") : "(none)");
  if (r.ran_commands) {
    txt += "\n\nNote: shell commands ran in these turns; their side effects (build output, installs...) are NOT reverted.";
  }
  return txt;
}

async function rewindTurn(turnId: string, keepBranch: boolean) {
  const info = await impactText(turnId);
  if (info.startsWith("RuntimeError") || info.startsWith("turn not on")) { chat.line(`\n[error] ${info}`, "c-error"); return; }
  const ok = await confirmModal("Rewind", info + "\n\nContinue?");
  if (!ok) return;
  const r = await call("rewind", { turn_id: turnId, keep_branch: keepBranch });
  if (r && r.__error) { chat.line(`\n[error] ${r.__error}`, "c-error"); return; }
  chat.line(`\n[rewound; restored ${(r.restored ?? []).length} file(s)]`, "c-warn");
  await replaySession();
  await refreshTurnList();
  await refreshSessionList();
  refreshContextEstimate();
}

async function editTurn(turnId: string) {
  const turns = await call("session_turns");
  if (turns && turns.__error) return;
  const t = (turns.turns ?? []).find((x: any) => x.id === turnId);
  if (!t) return;
  const info = await impactText(turnId);
  const res = await editPromptModal("Edit prompt and run again", info, t.prompt);
  if (!res) return;
  const wasPlan = t.task_type === "plan";
  const taskType = S.curTaskType;
  const r = await call("edit_and_resubmit", {
    turn_id: turnId, prompt: res.prompt, task_type: taskType,
    keep_branch: res.keepBranch, plan_mode: wasPlan,
  });
  if (r && r.__error) { chat.line(`\n[error] ${r.__error}`, "c-error"); return; }
  setBusy(true);
  S.thinkChars = 0;
}

function wireTurnList() {
  const ul = $("turn-list");
  ul.addEventListener("contextmenu", (e) => {
    const li = (e.target as HTMLElement).closest("li");
    if (!li || S.busy) return;
    e.preventDefault();
    const turns = (ul as any).__turns as any[] | undefined;
    const t = turns?.find((x) => x.id === li.dataset.id);
    if (!t || !t.active) return;
    showMenu(e.clientX, e.clientY, [
      { label: "Edit this prompt and run again...", fn: () => editTurn(t.id) },
      { label: "Rewind to before this turn (delete it and later turns)", fn: () => rewindTurn(t.id, false) },
      { label: "Rewind to before this turn (keep later turns as branch)", fn: () => rewindTurn(t.id, true) },
    ]);
  });
}
wireTurnList();

// ------------------------------------------------------------------ sending
async function send() {
  const input = $("input") as HTMLTextAreaElement;
  const prompt = input.value.trim();
  if (!prompt || !S.root) return;
  input.value = "";
  const images = S.attachments.slice();
  S.attachments = [];
  renderAttachStrip();
  const taskType = S.curTaskType;
  // the input box is also visible on the sessions list: sending there
  // starts a fresh session and enters it first. Resolve the attached file
  // BEFORE that (startNewSession clears the file view and would silently
  // drop the attachment).
  const fullPrompt = await withAttachedFile(prompt);
  // a turn is already running: queue the message as a steer. The agent picks
  // it up at the next safe point (right away if it is between model calls,
  // after the current stream is aborted if it is mid-reply, after the running
  // command finishes if it is executing one) and continues with it.
  if (S.busy) {
    if (images.length) chat.line("\n[steer: image attachments are not sent with a steer]", "c-warn");
    userPromptCard(fullPrompt, `[steer]  ${stampOf(Date.now() / 1000)}`);
    const r = await call("steer", { prompt: fullPrompt });
    if (r && r.__error) {
      chat.line(`\n[error] steer: ${r.__error}`, "c-error");
      setBusy(false);
    }
    return;
  }
  if (!$("session-list-view").classList.contains("hidden")) {
    if (!(await startNewSession())) return;
  }
  if (S.mode === 1) {
    if (images.length) chat.line("\n[plan mode: images are not sent to the planner]", "c-warn");
    call("submit_plan", { goal: fullPrompt }).then((r) => afterSubmit(r));
  } else {
    // effort: the GUI selector ("default" = use the saved setting)
    call("submit", { prompt: fullPrompt, task_type: taskType, images, effort: S.effort === "default" ? null : S.effort }).then((r) => afterSubmit(r));
  }
}

// Re-send a turn's prompt: rewind to it (discarding it and later turns),
// then submit the same prompt again.
async function resendTurn(turnId: string) {
  if (S.busy || !S.root) return;
  const turns = await call("session_turns");
  if (turns && turns.__error) { chat.line(`\n[error] ${turns.__error}`, "c-error"); return; }
  const active = (turns.turns ?? []).filter((t: any) => t.active);
  const last = active[active.length - 1];
  if (!last) { chat.line("\n[nothing to re-send: no turns yet]", "c-warn"); return; }
  if (last.id !== turnId) { chat.line("\n[can only re-send the latest turn]", "c-warn"); return; }
  const info = await impactText(last.id);
  if (info.startsWith("RuntimeError") || info.startsWith("turn not on")) { chat.line(`\n[error] ${info}`, "c-error"); return; }
  const ok = await confirmModal("Re-send last prompt", `Rewind to the last prompt and send it again:\n\n"${last.prompt}"\n\n${info}\n\nContinue?`);
  if (!ok) return;
  const wasPlan = last.task_type === "plan";
  const r = await call("edit_and_resubmit", {
    turn_id: last.id, prompt: last.prompt,
    task_type: wasPlan ? null : (last.task_type || null),
    keep_branch: false, plan_mode: wasPlan,
  });
  if (r && r.__error) { chat.line(`\n[error] ${r.__error}`, "c-error"); return; }
  setBusy(true);
  S.thinkChars = 0;
}

function afterSubmit(r: any) {
  if (r && r.__error) {
    chat.line(`\n[error] ${r.__error}`, "c-error");
    setBusy(false);
    return;
  }
  setBusy(true);
  S.thinkChars = 0;
}

// ------------------------------------------------------------------- events
window.api.onEvent(onEvent);
// exposed for automated UI tests (CDP)
(window as any).__onEvent = onEvent;

function onEvent(ev: AgentEvent) {
  const k = ev.event;
  const d = ev.data;
  if (k === "turn_started") {
    S.block = null;
    S.curTurnId = d.turn_id ?? null;
    S.curTurnBlocks = [];
    thinking.clear();
    S.thinkChars = 0;
    S.todos = [];
    renderTodos();
    userPromptCard(d.prompt, `[${d.task_type}]  ${stampOf(ev.ts)}`);
    if (Array.isArray(d.images) && d.images.length) {
      const im = document.createElement("span");
      im.className = "c-muted";
      im.textContent = `[images: ${d.images.join(", ")}]\n`;
      chat.el.appendChild(im);
    }
    // tool activity starts visible; collapses behind the chip at turn_finished
    S.stepsCount = 0;
    S.turnStart = Date.now();
    log(ev, `task type ${d.task_type}`);
    refreshTurnList();
    refreshSessionList();
  } else if (k === "thinking_delta") {
    S.thinkChars += (d.text ?? "").length;
    thinking.write(d.text, "c-muted");
  } else if (k === "content_delta") {
    if (S.block !== ev.agent_id) {
      S.block = ev.agent_id;
      S.blockFirst = true;
    }
    // the header line already ends with a newline; drop the leading newlines
    // of the first content chunk so there is no double blank line
    const t = S.blockFirst ? (d.text ?? "").replace(/^\n+/, "") : (d.text ?? "");
    S.blockFirst = false;
    if (!S.mdBlock) { S.mdBlock = new MdBlock(chat.el); S.curTurnBlocks.push(S.mdBlock); }
    S.mdBlock.append(t);
  } else if (k === "tool_call") {
    S.stepsCount += 1;
    if (!S.stepsBody) S.stepsBody = stepsChipEl(); // first tool call: show the chip
    updateStepsChip();
    chatTool(d.name, d.args ?? {}, ev.agent_id);
    log(ev, `${d.name} ${argsSummary(d.name, d.args ?? {})}`, "c-tool");
    const p = String((d.args ?? {}).path ?? "");
    if (p) S.toolPaths.set(d.id ?? "", p);
  } else if (k === "tool_result") {
    const tp = S.toolPaths.get(d.id ?? "") ?? "";
    S.toolPaths.delete(d.id ?? "");
    chatResult(!!d.ok, d.text ?? "", d.name ?? "", tp);
    log(ev, (d.ok ? "ok " : "FAILED ") + (d.text ?? ""), d.ok ? "" : "c-error");
  } else if (k === "command_output") {
    commands.write(d.text ?? "", "", true);
  } else if (k === "terminal_output" || k === "terminal_exited") {
    onTermEvent(k, d);
  } else if (k === "status") {
    setState(d.state, d.detail ?? "");
    if (d.state === "running_tool") commands.line(`\n$ (${d.detail ?? ""})`, "c-tool", true);
    log(ev, `${d.state} ${d.detail ?? ""}`, "c-muted");
  } else if (k === "approval_resolved") {
    const who = d.auto ? "auto" : "user";
    log(ev, `${d.allow ? "allowed" : "denied"} by ${who}: ${d.reason ?? ""}`, d.allow ? "c-ok" : "c-warn");
  } else if (k === "llm_done") {
    const u = d.usage ?? {};
    const el = d.elapsed ?? 0;
    const ttft = d.ttft;
    const tps = el && u ? (u.completion ?? 0) / el : 0;
    $("llm-label").textContent = ttft != null
      ? `ttft ${ttft.toFixed(1)}s | ${tps.toFixed(1)} tok/s | ${u.prompt ?? "?"} prompt tok`
      : "";
    log(ev, `${el.toFixed(1)}s ttft=${ttft == null ? "?" : ttft.toFixed(1)} usage=${JSON.stringify(u)} finish=${d.finish}`);
    S.thinkChars = 0;
  } else if (k === "context_usage") {
    setCtxBar(d.tokens, d.max_tokens, !!d.exact);
  } else if (k === "context_compressed") {
    chat.line(`\n[context compressed: ${d.before} -> ${d.after} tokens (${d.algorithm})]`, "c-warn");
    log(ev, `${d.before} -> ${d.after} tokens via ${d.algorithm}`, "c-warn");
  } else if (k === "warning" || k === "error") {
    chat.line(`\n[${k}] ${d.text ?? ""}`, k === "error" ? "c-error" : "c-warn");
    log(ev, d.text ?? "", k === "error" ? "c-error" : "c-warn");
  } else if (k === "turn_finished") {
    panelCancelAll();
    S.mdBlock?.finish();
    S.mdBlock = null;
    // collapse the tool activity behind the "Completed N steps in Xs" chip
    if (S.stepsBody) {
      if (S.stepsCount === 0) {
        S.stepsBody.previousElementSibling?.remove();
        S.stepsBody.remove();
      } else updateStepsChip();
      S.stepsBody = null;
    }
    if (d.status !== "ok") chat.line(`\n-- ${d.status} --`, "c-muted");
    if (S.curTurnId && S.curTurnBlocks.length) turnActionBar(S.curTurnId, S.curTurnBlocks);
    S.curTurnId = null;
    S.curTurnBlocks = [];
    log(ev, d.status);
    setBusy(false);
    setState("idle", "");
    refreshTurnList();
    refreshSessionList();
    refreshServerInfo();
    void refreshFileTree();
  } else if (k === "agent_finished") {
    log(ev, `${d.status} after ${d.steps} step(s)`);
  } else if (k === "plan_created" || k === "plan_started" || k === "subtask_started" || k === "subtask_finished" || k === "plan_finished") {
    S.planDict = d.plan;
    renderPlan();
    const extra = d.id ?? d.status ?? "";
    log(ev, `${extra} (${(d.plan?.subtasks ?? []).length} subtasks)`);
    if (k === "plan_created") chat.line(`\n[plan: ${(d.plan?.subtasks ?? []).length} subtasks]`, "c-tool");
  } else if (k === "stage_started" || k === "stage_finished") {
    log(ev, `stage ${d.index + 1}` + (k === "stage_started" ? `/${d.total} ids=${(d.ids ?? []).join(", ")}` : ""));
    if (k === "stage_started") {
      chat.line(`\n== stage ${d.index + 1}/${d.total}: ${(d.ids ?? []).join(", ") || "nothing to run"} ==`, "c-tool b");
      S.block = null;
    }
  } else if (k === "doc_analysis") {
    log(ev, `${d.subtask} read ${(d.docs ?? []).join(", ")} (${d.source})`);
  } else if (k === "session_rewound") {
    void (async () => {
      await replaySession();
      await refreshTurnList();
      await refreshSessionList();
      refreshContextEstimate();
      await refreshFileTree();
    })();
  } else if (k === "session_approve") {
    // "allow all in this session" was granted: the footer chip switches to it
    S.sessionApprove = !!d.active;
    refreshApprovalLabel();
    chat.line("\n[allow all in this session: enabled - only denied commands/files will be blocked]", "c-ok");
  } else if (k === "steer_injected") {
    // a queued steer message was picked up by the running turn
    chat.line(`\n[steer: the agent picked up your message and continues]`, "c-ok");
    log(ev, `steer injected: ${short(d.text ?? "", 120)}`, "c-ok");
  } else if (k === "approval_requested") {
    log(ev, `approval requested: ${d.title ?? d.kind}`, "c-warn");
    void (async () => {
      const resp = await approvalDialog(d);
      if (resp) await answerQuietly(d.req_id, resp);
    })();
  } else if (k === "ask_user_requested") {
    log(ev, `question: ${short(d.question ?? "", 120)}`, "c-warn");
    void (async () => {
      const resp = await askUserDialog(d);
      if (resp) await answerQuietly(d.req_id, resp);
    })();
  } else if (k === "plan_review_requested") {
    log(ev, "plan review requested", "c-warn");
    void (async () => {
      const plan = await planDialog(d, S.taskTypes);
      // null = cancelled (plan rejected); otherwise the (possibly edited) plan dict
      await call("answer", { req_id: d.req_id, response: plan });
    })();
  } else if (k === "todo_updated") {
    S.todos = Array.isArray(d.todos) ? d.todos : [];
    renderTodos();
    log(ev, `todos ${S.todos.filter((t) => t.status === "done").length}/${S.todos.length}`);
  } else if (k === "web_open") {
    // the agent asked to show a local page in a browser tab
    openWeb(String(d.url ?? ""));
    chat.line(`\n[web page opened: ${d.url ?? ""}]`, "c-tool");
    log(ev, `web page opened: ${d.url ?? ""}`);
  } else if (k === "stage_confirm_requested") {
    log(ev, "stage confirm requested", "c-warn");
    void (async () => {
      const decision = await stageDialog(d);
      await call("answer", { req_id: d.req_id, response: decision });
    })();
  }
}

function log(ev: AgentEvent, text: string, cls = "") {
  activity.line(`${stampOf(ev.ts)} [${ev.agent_id}] ${ev.event}: ${short(text, 220)}`, cls, true);
}

function stampOf(epochSec: number): string {
  const ts = new Date(epochSec * 1000);
  return `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}`;
}

// -------------------------------------------------------------------- todos
const TODO_MARKS: Record<string, string> = { done: "☑", in_progress: "◉", pending: "○" };

function renderTodos() {
  const panel = $("todo-panel");
  const list = $("todo-list");
  list.innerHTML = "";
  if (!S.todos.length) { panel.classList.add("hidden"); return; }
  panel.classList.remove("hidden");
  const done = S.todos.filter((t) => t.status === "done").length;
  $("todo-title").textContent = `Todos (${done}/${S.todos.length})`;
  for (const t of S.todos) {
    const li = document.createElement("li");
    li.className = `todo-${t.status}`;
    const mark = document.createElement("span");
    mark.className = "todo-mark";
    mark.textContent = TODO_MARKS[t.status] ?? "○";
    const text = document.createElement("span");
    text.className = "todo-text";
    text.textContent = t.content;
    li.append(mark, text);
    list.appendChild(li);
  }
}

$("todo-header").addEventListener("click", () => $("todo-panel").classList.toggle("todo-collapsed"));

// -------------------------------------------------------------------- plan
const PLAN_COLORS: Record<string, string> = {
  done: "c-ok", running: "c-tool", failed: "c-error", skipped: "c-warn", cancelled: "c-warn",
};

function renderPlan() {
  planView.innerHTML = "";
  if (!S.planDict) return;
  const plan = S.planDict;
  const subs: any[] = plan.subtasks ?? [];
  const line = (text: string, cls = "", bold = false) => {
    const div = document.createElement("div");
    if (cls) div.className = cls;
    if (bold) div.classList.add("b");
    div.textContent = text;
    planView.appendChild(div);
  };
  line(`Goal: ${plan.goal ?? ""}`, "", true);
  // group into stages by dependency level (same as the backend Plan.stages())
  const done = new Set<string>();
  const remaining = new Map(subs.map((s) => [s.id, s]));
  let stageNo = 0;
  while (remaining.size) {
    const level = [...remaining.values()].filter((s) => (s.depends_on ?? []).every((x: string) => done.has(x)));
    if (!level.length) { // broken deps: show the rest as one stage
      line(`\nStage ${++stageNo}`, "", true);
      for (const s of remaining.values()) renderSubtask(s);
      break;
    }
    line(`\nStage ${++stageNo}`, "", true);
    for (const s of level) { done.add(s.id); remaining.delete(s.id); renderSubtask(s); }
  }
  function renderSubtask(s: any) {
    line(`  ${s.id} [${s.status ?? "pending"}] (${s.task_type}) ${s.title ?? ""}`, PLAN_COLORS[s.status] ?? "c-muted");
    if ((s.depends_on ?? []).length) line(`      after: ${(s.depends_on as string[]).join(", ")}`, "c-muted");
    if (s.summary) line(`      ${short(s.summary, 200)}`, "c-muted");
  }
}

// -------------------------------------------------------------------- tabs
function bindTabs(barId: string, pagesId: string, pagePrefix: string) {
  const bar = $(barId);
  const pages = $(pagesId);
  bar.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      bar.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const name = (btn as HTMLElement).dataset.tab!;
      pages.querySelectorAll(".tabpage").forEach((p) => p.classList.add("hidden"));
      $(pagePrefix + name).classList.remove("hidden");
    });
  });
}
bindTabs("left-rail", "left-pages", "tab-");
bindTabs("right-tabs", "bottom", "tab-");
// show the terminal action buttons (＋ / maximize / hide) only while the
// Terminals tab is active
document.querySelectorAll<HTMLButtonElement>("#right-tabs .tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    $("term-actions").classList.toggle("hidden", btn.dataset.tab !== "terminals");
  });
});
// maximize: expand the main display area (file view) to fill the whole body
$("term-max-btn").addEventListener("click", () => {
  document.body.classList.toggle("term-maximized");
});
// hide: collapse the bottom panel
$("term-hide-btn").addEventListener("click", () => {
  $("split-bottom").classList.add("hidden");
  $("bottom").classList.add("hidden");
});
$("tree-refresh-btn").addEventListener("click", () => void refreshFileTree());
// open a local web page in a browser tab (mid pane)
function webUrlSubmit() {
  const inp = $("web-url-input") as HTMLInputElement;
  let u = inp.value.trim();
  if (!u) return;
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  inp.value = "";
  openWeb(u);
}
$("web-open-btn").addEventListener("click", webUrlSubmit);
($("web-url-input") as HTMLInputElement).addEventListener("keydown", (e) => {
  if (e.key === "Enter") webUrlSubmit();
});

function switchLeftTab(name: string) {
  const btn = document.querySelector(`#left-rail .tab[data-tab="${name}"]`) as HTMLElement;
  btn?.click();
}

// ----------------------------------------------------------------- terminals
// Interactive shells on the backend (PTY). The list column shows open
// terminals; the pane hosts one xterm.js instance per terminal (kept alive
// while the tab is hidden so scrollback survives).
const S_TERM = {
  // ready=false until the terminal_open RPC answered: keystrokes typed in the
  // meantime are buffered and flushed, so nothing is written to a dead id
  terms: new Map<string, { x: XTerm; fit: FitAddon; closed: boolean; shell: string; ready: boolean; pending: string[] }>(),
  current: null as string | null,
};

function termListEl() { return $("term-list") as HTMLElement; }
function termPaneEl() { return $("term-pane") as HTMLElement; }

function renderTermList() {
  const ul = termListEl();
  ul.innerHTML = "";
  for (const [id, t] of S_TERM.terms) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${id}${t.closed ? " (exited)" : ""}`;
    li.appendChild(label);
    // close button: visible only while the row is hovered (see .term-x in CSS)
    const x = document.createElement("button");
    x.className = "term-x";
    x.title = "Close terminal";
    x.textContent = "✕";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTerminal(id);
    });
    li.appendChild(x);
    if (id === S_TERM.current) li.classList.add("selected");
    li.addEventListener("click", () => selectTerminal(id));
    ul.appendChild(li);
  }
}

function showTermPane(id: string | null) {
  const pane = termPaneEl();
  for (const [tid, t] of S_TERM.terms) {
    (t.x.element as HTMLElement).style.display = tid === id ? "" : "none";
  }
  let empty = pane.querySelector(".term-empty");
  if (id) {
    empty?.remove();
    const t = S_TERM.terms.get(id);
    if (t) {
      requestAnimationFrame(() => { t.fit.fit(); t.x.focus(); });
    }
  } else {
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "term-empty";
      empty.textContent = "no terminal - click ＋ to open one";
      pane.appendChild(empty);
    }
  }
}

function selectTerminal(id: string) {
  S_TERM.current = id;
  renderTermList();
  showTermPane(id);
}

function closeTerminal(id: string) {
  const t = S_TERM.terms.get(id);
  if (t) {
    t.x.dispose();
    S_TERM.terms.delete(id);
  }
  if (S_TERM.current === id) S_TERM.current = null;
  call("terminal_close", { id });
  renderTermList();
  showTermPane(S_TERM.current);
}

// create an xterm.js instance in the terminal pane, register it under ``id``
// and bind input/resize to the backend. Returns the instance (for disposal).
function createTermX(id: string, ready: boolean) {
  const pane = termPaneEl();
  const x = new XTerm({
    cursorBlink: true,
    fontSize: 12,
    theme: { background: "#1e1e1e" },
    scrollback: 5000,
  });
  const fit = new FitAddon();
  x.loadAddon(fit);
  x.open(pane);
  (x.element as HTMLElement).style.display = "none";
  (x.element as any).__xterm = x;  // CDP test hook
  S_TERM.terms.set(id, { x, fit, closed: false, shell: "", ready, pending: [] });
  x.onData((data) => {
    const rec = S_TERM.terms.get(id);
    if (!rec) return;
    if (!rec.ready) { rec.pending.push(data); return; }  // RPC still in flight
    call("terminal_write", { id, data });
  });
  x.onResize(({ cols, rows }) => call("terminal_resize", { id, cols, rows }));
  // copy / paste shortcuts: the app has no native menu, so xterm's own
  // selection must be bridged to the clipboard. Ctrl+Shift+C copies (plain
  // Ctrl+C must keep reaching the shell as SIGINT); Ctrl+Shift+V / Ctrl+V
  // paste (plain Ctrl+V is a readline kill-word in the shell).
  x.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "v" || e.key === "V")) {
      navigator.clipboard.readText().then((t) => t && x.paste(t)).catch(() => {});
      return false;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "c" || e.key === "C")) {
      const sel = x.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      return false;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "a" || e.key === "A")) {
      x.selectAll();
      return false;
    }
    return true;
  });
  return x;
}

// right-click menu on the log panes (Activity / Thinking / Commands /
// chat): copy the current selection, paste into the chat input.
document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  const logEl = t.closest("#tab-activity, #tab-thinking, #tab-commands, #chat");
  if (!logEl) return;
  e.preventDefault();
  const sel = window.getSelection();
  const text = sel && sel.rangeCount ? sel.toString() : "";
  const items: { label: string; enabled?: boolean; fn?: () => void }[] = [];
  if (text) items.push({ label: "Copy", fn: () => navigator.clipboard.writeText(text).catch(() => {}) });
  if (logEl.id === "chat") {
    items.push({ label: "Paste", fn: () => navigator.clipboard.readText().then((t2) => {
      const inp = $("input") as HTMLTextAreaElement;
      const s = inp.selectionStart ?? inp.value.length, en = inp.selectionEnd ?? s;
      inp.value = inp.value.slice(0, s) + t2 + inp.value.slice(en);
      inp.selectionStart = inp.selectionEnd = s + t2.length;
      inp.focus();
    }).catch(() => {}) });
  }
  if (!items.length) items.push({ label: "No selection", enabled: false });
  showMenu(e.clientX, e.clientY, items);
});

// right-click menu on the terminal: copy / paste / select all
document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest("#term-pane")) return;
  e.preventDefault();
  const x = S_TERM.terms.get(S_TERM.current ?? "")?.x;
  if (!x) return;
  showMenu(e.clientX, e.clientY, [
    { label: "Copy", enabled: !!x.getSelection(), fn: () => { const s = x.getSelection(); if (s) navigator.clipboard.writeText(s).catch(() => {}); } },
    { label: "Paste", fn: () => navigator.clipboard.readText().then((t) => t && x.paste(t)).catch(() => {}) },
    { label: "Select all", fn: () => x.selectAll() },
  ]);
});

async function openTerminal() {
  const id = `term-${Date.now().toString(36)}`;  // placeholder until the RPC answers
  createTermX(id, false);
  renderTermList();  // show the pending entry immediately

  const r = await call("terminal_open", { cols: 80, rows: 24, cwd: S.root ?? undefined });
  if (r?.__error) {
    const t = S_TERM.terms.get(id);
    t?.x.dispose();
    S_TERM.terms.delete(id);
    chat.line(`\n[terminal] ${r.__error}`, "c-error");
    renderTermList();
    return;
  }
  const real = r.id as string;
  const t = S_TERM.terms.get(id);
  const pending = t?.pending ?? [];
  S_TERM.terms.delete(id);
  if (t) t.x.dispose();
  createTermX(real, true);
  const rec = S_TERM.terms.get(real)!;
  rec.shell = r.shell ?? "";
  for (const data of pending) call("terminal_write", { id: real, data });  // flush early keystrokes
  selectTerminal(real);
}

function onTermEvent(k: string, d: Record<string, any>) {
  const id = d.id as string;
  const t = S_TERM.terms.get(id);
  if (!t) return;
  if (k === "terminal_output") t.x.write(d.text ?? "");
  else if (k === "terminal_exited") {
    t.closed = true;
    t.x.write(`\r\n[process exited${d.exit_code != null ? ` with code ${d.exit_code}` : ""}]\r\n`);
    renderTermList();
  }
}

$("term-new-btn").addEventListener("click", () => void openTerminal());
// exposed for automated UI tests (CDP)
Object.defineProperty(window, "__terminals", {
  get: () => ({ count: S_TERM.terms.size, current: S_TERM.current }),
});
// re-fit the visible terminal when the pane resizes (window / splitter drag)
new ResizeObserver(() => {
  if (S_TERM.current) S_TERM.terms.get(S_TERM.current)?.fit.fit();
}).observe(termPaneEl());

// --------------------------------------------------------------- file attach
// Insert a file's content into the prompt so it is part of the message
// sent to the agent. Only text-like files are accepted.
const MAX_FILE_CHARS = 100_000; // keep the prompt manageable
const TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".log", ".text",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env",
  ".csv", ".tsv", ".xml", ".html", ".htm", ".css", ".scss", ".less",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".vue", ".svelte",
  ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hxx", ".hh", ".cs", ".rs",
  ".go", ".java", ".kt", ".swift", ".m", ".mm", ".rb", ".php", ".lua", ".pl",
  ".py", ".sh", ".bash", ".zsh", ".bat", ".ps1", ".sql", ".r", ".dart",
  ".tex", ".proto", ".cmake", ".makefile",
]);

function isTextFile(p: string): boolean {
  const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
  return TEXT_EXTS.has(ext);
}

async function insertFile(p: string) {
  if (!isTextFile(p)) {
    chat.line(`\n[skipped ${p}: only text files can be inserted]`, "c-warn");
    return;
  }
  const r = await window.api.readFile(p);
  if (r.error) {
    chat.line(`\n[could not read ${p}: ${r.error}]`, "c-error");
    return;
  }
  let content = r.content!;
  let note = "";
  if (content.length > MAX_FILE_CHARS) {
    content = content.slice(0, MAX_FILE_CHARS);
    note = `\n... (truncated, ${content.length} of ${r.content!.length} chars)`;
  }
  const input = $("input") as HTMLTextAreaElement;
  const cur = input.value;
  const sep = cur && !cur.endsWith("\n") ? "\n" : "";
  input.value = `${cur}${sep}\n<file ${p}>\n${content}${note}\n</file>\n`;
  input.focus();
}

// ＋ button: a menu with "Attach file..." and the task types (auto = none)
$("attach-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const items: { label: string; enabled?: boolean; fn?: () => void }[] = [
    { label: "📎  Attach file...", fn: async () => {
      const files = await window.api.pickFiles();
      for (const f of files) await insertFile(f);
    } },
  ];
  for (const t of S.taskTypes) {
    items.push({ label: `Task type: ${t}`, fn: () => { S.curTaskType = t; } });
  }
  items.push({ label: "Task type: (auto)", fn: () => { S.curTaskType = null; } });
  showMenu(rect.left, rect.bottom + 4, items);
});

// Drag & drop files onto the prompt: text files are inserted, images attached.
const inputEl = $("input") as HTMLTextAreaElement;
inputEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer!.dropEffect = "copy";
});
inputEl.addEventListener("drop", async (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer!.files);
  if (!files.length) return; // plain text drop: let the browser handle it
  for (const f of files) {
    if (f.type.startsWith("image/")) await addImageFile(f);
    else await insertFile((f as any).path);
  }
});

// ------------------------------------------------------------------ image attach
// Pasted / dropped / picked images become attachments sent with the prompt as
// image_url parts (OpenAI-compatible vision). Kept as downscaled data URLs.
const MAX_IMAGES = 5;
const MAX_IMAGE_MB = 10;
const MAX_IMAGE_EDGE = 1568; // ~token-friendly size for common vision models

function imageThumbStrip() { return $("attach-strip") as HTMLElement; }

function renderAttachStrip() {
  const strip = imageThumbStrip();
  strip.innerHTML = "";
  for (const [i, a] of S.attachments.entries()) {
    const item = document.createElement("div");
    item.className = "attach-item";
    const img = document.createElement("img");
    img.src = a.data_url;
    img.title = a.name;
    const x = document.createElement("button");
    x.className = "attach-x";
    x.textContent = "✕";
    x.title = "remove";
    x.addEventListener("click", () => { S.attachments.splice(i, 1); renderAttachStrip(); });
    item.appendChild(img);
    item.appendChild(x);
    strip.appendChild(item);
  }
  strip.classList.toggle("hidden", S.attachments.length === 0);
}

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(f);
  });
}

// Downscale large images on a canvas so the payload (and token cost) stays small.
async function downscale(f: File, dataUrl: string): Promise<string> {
  if (f.size < 1_000_000) return dataUrl; // small enough as-is
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const el = new Image();
      el.onload = () => res(el);
      el.onerror = () => rej(new Error("decode failed"));
      el.src = dataUrl;
    });
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
    if (scale >= 1) return dataUrl;
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  } catch {
    return dataUrl; // not decodable: send as-is, let the model side complain if needed
  }
}

async function addImages(items: { name: string; data_url: string }[]) {
  for (const a of items) {
    if (S.attachments.length >= MAX_IMAGES) {
      chat.line(`\n[max ${MAX_IMAGES} images per message]`, "c-warn");
      break;
    }
    if (a.data_url.length > MAX_IMAGE_MB * 1024 * 1024) {
      chat.line(`\n[skipped ${a.name}: over ${MAX_IMAGE_MB} MB]`, "c-warn");
      continue;
    }
    S.attachments.push(a);
  }
  renderAttachStrip();
}

async function addImageFile(f: File) {
  if (f.size > MAX_IMAGE_MB * 1024 * 1024) {
    chat.line(`\n[skipped ${f.name}: over ${MAX_IMAGE_MB} MB]`, "c-warn");
    return;
  }
  const dataUrl = await fileToDataUrl(f);
  const scaled = await downscale(f, dataUrl);
  await addImages([{ name: f.name, data_url: scaled }]);
}

// paste: images from the clipboard (screenshots, copied pictures)
inputEl.addEventListener("paste", (e) => {
  const files: File[] = [];
  for (const it of Array.from(e.clipboardData?.items ?? [])) {
    if (it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (!files.length) return;
  e.preventDefault();
  // returns the attach promise (also used by the CDP paste test)
  return Promise.all(files.map((f) => addImageFile(f))).then(() => S.attachments.length);
});

$("image-btn").addEventListener("click", async () => {
  const files = await window.api.pickImages();
  await addImages(files);
});

// exposed for automated UI tests (CDP)
(window as any).__addImageAttachment = (name: string, dataUrl: string) =>
  addImages([{ name, data_url: dataUrl }]).then(() => S.attachments.length);
Object.defineProperty(window, "__attachments", { get: () => S.attachments });
Object.defineProperty(window, "__root", { get: () => S.root });
(window as any).__setBusy = setBusy;
// render a tool line + result in the chat (used by CDP tests to exercise the
// collapsible tool output without a running LLM)
(window as any).__chatTool = (name: string, args: Record<string, any>, result?: string, ok = true) => {
  chatTool(name, args);
  if (result !== undefined) chatResult(ok, result);
};

// ------------------------------------------------------------------ wiring
$("send-btn").addEventListener("click", () => {
  if (S.busy) {
    // the send button is the stop button while a turn is running
    call("cancel");
    chat.line("\n[stopping...]", "c-warn");
    return;
  }
  void send();
});
$("input").addEventListener("keydown", (e) => {
  if (e.code === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    const s = inputEl.selectionStart ?? inputEl.value.length;
    const n = inputEl.selectionEnd ?? s;
    inputEl.value = inputEl.value.slice(0, s) + "\n" + inputEl.value.slice(n);
    inputEl.selectionStart = inputEl.selectionEnd = s + 1;
    return;
  }
  // ignore Enter while an IME (e.g. Chinese pinyin) composition is in progress
  if (e.isComposing || e.keyCode === 229) return;
  if (e.code === "Enter") { e.preventDefault(); send(); }
});
// mode button in the input toolbar: Agent / Plan & subtasks (was the toolbar select)
$("mode-combo-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 4, [
    { label: "Agent (single agent)", fn: () => { S.mode = 0; } },
    { label: "Plan & subtasks (review the plan, confirm each stage)", fn: () => { S.mode = 1; } },
  ]);
});
$("effort-combo").addEventListener("click", (e) => {
  e.stopPropagation();
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 4,
    ["default", "none", "low", "medium", "high"].map((v) => ({
      label: v + (v === S.effort ? "  ✓" : ""),
      fn: () => { S.effort = v; refreshEffortLabel(); },
    })));
});
// model chip -> Settings > Model
$("model-combo").addEventListener("click", () => {
  if (S.busy) { chat.line("\n[settings disabled while a turn is running]", "c-muted"); return; }
  void settingsDialog("model").then((saved) => { if (saved) { refreshModelLabel(); chat.line("\n[settings saved]", "c-ok"); } });
});
// footer chips -> Settings (connection / approval)
$("conn-mode-label").addEventListener("click", () => {
  if (S.busy) { chat.line("\n[settings disabled while a turn is running]", "c-muted"); return; }
  void settingsDialog("connection").then((saved) => { if (saved) { refreshConnLabel(); chat.line("\n[settings saved]", "c-ok"); } });
});
$("approval-label").addEventListener("click", () => {
  if (S.busy) { chat.line("\n[settings disabled while a turn is running]", "c-muted"); return; }
  void settingsDialog("approval").then((saved) => { if (saved) { refreshApprovalLabel(); chat.line("\n[settings saved]", "c-ok"); } });
});
// chat view toolbar: jump to the turns list
$("chat-turns-btn").addEventListener("click", () => switchLeftTab("turns"));
$("server-ctx-btn").addEventListener("click", refreshServerInfo);
// start a fresh session and enter its chat view; false on error (already
// reported in the chat)
async function startNewSession(): Promise<boolean> {
  if (S.busy || !S.root) return false;
  const r = await call("new_session");
  if (r && r.__error) { chat.line(`\n[error] ${r.__error}`, "c-error"); return false; }
  S.sessionApprove = false; // a new session: "allow all in this session" is reset
  refreshApprovalLabel();
  resetViews();
  await refreshTurnList();
  await refreshSessionList();
  refreshContextEstimate();
  clearFileView();
  void refreshFileTree();
  showSessionChat("new session");
  return true;
}
$("new-session-btn").addEventListener("click", () => void startNewSession());
// window controls (frameless window: the page draws its own title bar)
$("win-min").addEventListener("click", () => void window.api.winMinimize());
$("win-close").addEventListener("click", () => void window.api.winClose());
// window maximize/restore icons: single square (maximize) and the VS Code-style
// "restore" glyph - two overlapping squares (front one filled with the panel
// color so the overlap reads as a shadow/ghost of the back window).
const ICON_MAX = '<svg width="12" height="12" viewBox="0 0 16 16" style="display:block"><rect x="2.5" y="2.5" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const ICON_RESTORE = '<svg width="12" height="12" viewBox="0 0 16 16" style="display:block">'
  + '<rect x="5" y="2.5" width="8.5" height="8.5" fill="none" stroke="currentColor" stroke-width="1.3"/>'
  + '<rect x="2.5" y="5" width="8.5" height="8.5" fill="var(--panel)" stroke="currentColor" stroke-width="1.3"/></svg>';
function setMaxIcon(maxed: boolean) {
  const b = $("win-max") as HTMLButtonElement;
  b.innerHTML = maxed ? ICON_RESTORE : ICON_MAX;
  b.title = maxed ? "Restore" : "Maximize";
}
void window.api.winIsMaximized().then(setMaxIcon);
$("win-max").addEventListener("click", async () => {
  setMaxIcon(await window.api.winToggleMaximize());
});

// left rail: gear -> Settings dialog; the project icon opens the projects
// dialog in addition to switching to the Turns page (see bindTabs)
$("rail-settings").addEventListener("click", () => {
  if (S.busy) { chat.line("\n[settings disabled while a turn is running]", "c-muted"); return; }
  void settingsDialog().then((saved) => { if (saved) chat.line("\n[settings saved]", "c-ok"); });
});
void refreshConnLabel();
refreshModelLabel();
refreshApprovalLabel();

// ------------------------------------------------------------- projects
// Saved projects are remembered by name (localStorage): {name, mode, path}.
// mode "local"  = path on the machine the GUI runs on (native pick dialog).
// mode "remote" = path on the machine the backend runs on (browsed via the
// list_dir RPC). In the current local-server build both resolve to the same
// machine, but the split keeps the remote build a pure renderer change.
interface SavedProject { name: string; mode: "local" | "remote"; path: string; }

const PROJECTS_KEY = "coder-agent.projects";
const LAST_PROJECT_KEY = "coder-agent.last-project";

function loadProjects(): SavedProject[] {
  try { return JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? "[]"); } catch { return []; }
}
function saveProjects(list: SavedProject[]) {
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
function lastProjectName(): string | null {
  try { return localStorage.getItem(LAST_PROJECT_KEY); } catch { return null; }
}
function setLastProjectName(name: string | null) {
  try { if (name) localStorage.setItem(LAST_PROJECT_KEY, name); else localStorage.removeItem(LAST_PROJECT_KEY); } catch { /* ignore */ }
}

function rememberProject(name: string, mode: "local" | "remote", path: string) {
  const list = loadProjects().filter((p) => !(p.name === name && p.path === path));
  list.push({ name, mode, path });
  saveProjects(list);
}

async function openProjectNamed(name: string, mode: "local" | "remote", path: string) {
  // a "local" project is a path on THIS machine; in remote mode the server
  // lives on another machine and cannot see it
  const connMode = await window.api.getConnMode().catch(() => "local");
  if ((connMode === "remote" || connMode === "ssh") && mode === "local") {
    chat.line(`\n[error] project "${name}" (${path}) is on this machine, but the agent server runs remotely. Remove it and add the folder on the server instead.`, "c-error");
    return;
  }
  rememberProject(name, mode, path);
  setLastProjectName(name);
  if (!(await window.api.getBackendUrl())) {
    // backend not ready yet: queue it, boot / the backend-url listener opens it
    S.pendingRoot = path;
    chat.line(`\nProject queued: ${path} (will open when the backend is ready)`, "c-muted");
    return;
  }
  openProject(path);
}

// "user@host:~/path" is the ssh-style way users write remote paths; the
// host part is already the connection config, so only the path after the
// last colon is sent to the server.
function remoteBasePath(s: string): string {
  const i = s.lastIndexOf(":");
  if (i > 0 && s.slice(0, i).includes("@")) return s.slice(i + 1);
  return s;
}

// remote "add project": a text input (the fast path - most users know the
// path on the server) validated through the list_dir RPC, with the directory
// browser as a "Browse..." fallback. No password here: the connection's
// token (Settings > Connection) is what authenticates against the server.
const lastRemotePath = (): string | null => {
  const last = lastProjectName();
  if (!last) return null;
  const p = loadProjects().find((x) => x.name === last && x.mode === "remote");
  return p ? p.path : null;
};

function addRemoteProject(): Promise<string | null> {
  return new Promise((resolve) => {
    const bd = document.createElement("div");
    bd.className = "modal-backdrop stacked show";
    bd.innerHTML =
      `<div class="modal prompt"><div class="head">Add project (on the server machine)</div>` +
      `<div class="body"><div class="field"><input type="text" class="rpath" placeholder="~/mygitee/tmp"/></div>` +
      `<div class="tip" style="font-size:11px;color:var(--text-soft2);margin-top:6px">Path on the machine the agent server runs on. ` +
      `"user@host:~/path" is accepted too - only the path part is used.</div>` +
      `<div class="msg"></div></div>` +
      `<div class="foot"><button class="browse">Browse...</button><span class="flex1"></span>` +
      `<button class="no">Cancel</button><button class="primary yes">Add</button></div></div>`;
    document.body.appendChild(bd);
    const input = bd.querySelector<HTMLInputElement>(".rpath")!;
    const msg = bd.querySelector(".msg")!;
    const addBtn = bd.querySelector(".yes") as HTMLButtonElement;
    const browseBtn = bd.querySelector(".browse") as HTMLButtonElement;
    input.focus();
    let busy = false;
    const close = () => { bd.remove(); };

    async function validate(): Promise<string | null> {
      const raw = input.value.trim();
      if (!raw) { msg.className = "msg err"; msg.textContent = "Enter a path first."; return null; }
      const p = remoteBasePath(raw);
      const r = await call("list_dir", { path: p });
      if (r && r.__error) {
        msg.className = "msg err";
        msg.textContent = `Not a directory on the server: ${p}\n${r.__error}`;
        return null;
      }
      msg.className = "msg"; msg.textContent = "";
      return r.path;
    }

    async function doAdd() {
      if (busy) return;
      busy = true;
      addBtn.disabled = true;
      addBtn.textContent = "Checking...";
      const dir = await validate();
      busy = false;
      addBtn.disabled = false;
      addBtn.textContent = "Add";
      if (!dir) return;
      close();
      resolve(dir);
    }
    addBtn.addEventListener("click", () => void doAdd());
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") void doAdd(); });
    browseBtn.addEventListener("click", async () => {
      browseBtn.disabled = true;
      const dir = await browseRemoteDir(input.value.trim());
      browseBtn.disabled = false;
      if (dir) input.value = dir;
    });
    bd.querySelector(".no")!.addEventListener("click", () => { close(); resolve(null); });
    if (lastRemotePath()) input.value = lastRemotePath()!;
  });
}

// remote directory browser: a simple path bar + entry list via the list_dir RPC
function browseRemoteDir(initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = $("modal");
    modal.className = "modal wide";
    modal.innerHTML =
      `<div class="head">Choose a directory (on the backend machine)</div>` +
      `<div class="body"><div class="field"><input type="text" class="pathbar" placeholder="/path/to/project"/></div>` +
      `<div class="dirlist"></div><div class="msg"></div></div>` +
      `<div class="foot"><button class="up">..</button><span class="flex1"></span>` +
      `<button class="no">Cancel</button><button class="primary yes">Use this folder</button></div>`;
    const pathbar = modal.querySelector<HTMLInputElement>(".pathbar")!;
    const listEl = modal.querySelector(".dirlist")!;
    const msg = modal.querySelector(".msg")!;
    let cur = "";

    async function load(dir: string) {
      const r = await call("list_dir", { path: dir });
      if (r && r.__error) { msg.className = "msg err"; msg.textContent = r.__error; return; }
      msg.textContent = "";
      cur = r.path;
      pathbar.value = cur;
      listEl.innerHTML = r.entries.map((e: any) =>
        `<div class="dirent${e.dir ? " dir" : ""}"><span class="ico">${e.dir ? "📁" : "📄"}</span>${esc(e.name)}</div>`).join("");
      listEl.querySelectorAll(".dirent").forEach((el, idx) => {
        (el as HTMLElement).dataset.name = r.entries[idx].name;
        if (r.entries[idx].dir) {
          el.addEventListener("dblclick", () => void load(cur + (cur.endsWith("/") ? "" : "/") + r.entries[idx].name));
        }
      });
    }

    pathbar.addEventListener("keydown", (e) => { if (e.key === "Enter") void load(remoteBasePath(pathbar.value.trim()) || cur); });
    modal.querySelector(".up")!.addEventListener("click", () => {
      const parent = cur.replace(/[\\/][^\\/]+$/, "");
      if (parent && parent !== cur) void load(parent);
    });
    modal.querySelector(".yes")!.addEventListener("click", () => { $("modal-backdrop").classList.remove("show"); resolve(cur); });
    modal.querySelector(".no")!.addEventListener("click", () => { $("modal-backdrop").classList.remove("show"); resolve(null); });
    $("modal-backdrop").classList.add("show");
    void load(remoteBasePath(initial));
  });
}

async function projectsDialog(): Promise<void> {
  // in remote mode the project paths live on the server machine, so a native
  // folder dialog on this machine would pick paths the server cannot see; the
  // dialog therefore only shows projects matching the current connection mode
  const cm = await window.api.getConnMode().catch(() => "local");
  const remoteMode = cm === "remote" || cm === "ssh";
  const list = loadProjects().filter((p) => p.mode === (remoteMode ? "remote" : "local"));
  const last = lastProjectName();
  const modal = $("modal");
  modal.className = "modal wide";
  modal.innerHTML =
    `<div class="head">Projects</div>` +
    `<div class="body"><div class="projlist"></div>` +
    `<div class="msg"></div>` +
    `<div class="btnrow"><button class="add-project">+ Add project...</button>` +
    `<button class="rename">Rename</button><button class="del">Delete</button></div>` +
    `<div class="tip" style="font-size:11px;color:var(--text-soft2)">${remoteMode
      ? "Projects live on the machine the agent server runs on (type the path, e.g. ~/mygitee/tmp). "
      : "Projects live on this machine (native folder dialog). "}Projects are remembered by name.</div></div>` +
    `<div class="foot"><button class="open">Open</button><span class="flex1"></span><button class="primary yes">Close</button></div>`;
  const listEl = modal.querySelector(".projlist")!;
  const msg = modal.querySelector(".msg")!;
  let selected: SavedProject | null = null;

  function render() {
    listEl.innerHTML = list.map((p, i) =>
      `<div class="projrow${p === selected ? " sel" : ""}" data-idx="${i}">` +
      `<span class="pname">${esc(p.name)}${p.name === last ? "  (last)" : ""}</span>` +
      `<span class="pmode">${p.mode}</span><span class="ppath">${esc(p.path)}</span></div>`).join("");
  }
  render();

  // event delegation: render() rebuilds the rows, so listeners must live on
  // the container (per-row listeners are lost on re-render and the old
  // double-click handler never fired after the selection re-render).
  listEl.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".projrow");
    if (!row) return;
    selected = list[Number(row.dataset.idx)] ?? null;
    render();
  });
  listEl.addEventListener("dblclick", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".projrow");
    if (!row) return;
    const p = list[Number(row.dataset.idx)];
    if (!p) return;
    $("modal-backdrop").classList.remove("show");
    void openProjectNamed(p.name, p.mode, p.path);
  });
  modal.querySelector(".open")!.addEventListener("click", () => {
    if (!selected) return;
    $("modal-backdrop").classList.remove("show");
    void openProjectNamed(selected.name, selected.mode, selected.path);
  });

  // add a project for the current connection mode: native folder picker in
  // local mode, path text input (validated via list_dir, with the directory
  // browser as fallback) in remote mode. The saved project's mode is the
  // connection mode, so it only shows in the matching dialog.
  modal.querySelector(".add-project")!.addEventListener("click", async () => {
    let dir: string | null = null;
    if (remoteMode) {
      dir = await addRemoteProject();
    } else {
      // __pickDirectory is a CDP-test hook (see window.__onEvent); defaults to
      // the native picker, which a headless test cannot drive.
      const pick: () => Promise<string | null> = (window as any).__pickDirectory ?? window.api.pickDirectory;
      dir = await pick();
    }
    if (!dir) return;
    const name = await promptModal("Project name:", dir.split(/[\\/]/).filter(Boolean).pop() ?? dir);
    if (!name) return;
    list.push({ name, mode: remoteMode ? "remote" : "local", path: dir });
    saveProjects(list);
    selected = list[list.length - 1];
    render();
  });
  modal.querySelector(".rename")!.addEventListener("click", async () => {
    if (!selected) return;
    const name = await promptModal("New name:", selected.name);
    if (!name) return;
    selected.name = name;
    saveProjects(list);
    render();
  });
  modal.querySelector(".del")!.addEventListener("click", () => {
    if (!selected) return;
    const i = list.indexOf(selected);
    if (i >= 0) {
      list.splice(i, 1);
      saveProjects(list);
      if (selected.name === lastProjectName()) setLastProjectName(null);
      selected = null;
      render();
    }
  });
  modal.querySelector(".yes")!.addEventListener("click", () => $("modal-backdrop").classList.remove("show"));
  $("modal-backdrop").classList.add("show");
}

$("rail-project-menu").addEventListener("click", () => {
  if (S.busy) return;
  void projectsDialog();
});

// ------------------------------------------------------- resizable splitters
const SPLIT_DEFAULTS = { left: 260, bottom: 240 };
const SPLIT_LIMITS = {
  left: [180, 600] as const,
  bottom: [120, 600] as const,
};
const SPLIT_STORE = "coder-agent-panel-widths";

function loadSplitSizes(): { left?: number; bottom?: number } {
  try {
    const raw = localStorage.getItem(SPLIT_STORE);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSplitSizes() {
  const sizes = {
    left: Math.round($("left").getBoundingClientRect().width),
    bottom: Math.round($("bottom").getBoundingClientRect().height),
  };
  try { localStorage.setItem(SPLIT_STORE, JSON.stringify(sizes)); } catch { /* ignore */ }
}

function setSplitLeft(w: number) { ($("left") as HTMLElement).style.width = `${w}px`; }
function setSplitBottom(h: number) { ($("bottom") as HTMLElement).style.height = `${h}px`; }

function initLeftSplitter() {
  const splitter = $("split-left");
  const limits = SPLIT_LIMITS.left;
  const body = $("body");

  splitter.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.classList.add("dragging");
    document.body.classList.add("resizing");
    // where inside the handle the mouse grabbed it, so the pane does not
    // jump on the first move
    const grab = e.clientX - (splitter.getBoundingClientRect().left + 1);

    const onMove = (ev: MouseEvent) => {
      // position the pane from the cursor: the handle's center stays at
      // (cursor - grab) at all times.
      //   4px body padding + 2px splitter margin + 1px half splitter width = 7px
      // (w is the border-box width, so the pane border is already inside it)
      const bodyRect = body.getBoundingClientRect();
      let w = ev.clientX - grab - bodyRect.left - 7;
      // clamp: within limits and leave at least 120px for the middle pane.
      // non-mid space = 2x padding(4) + 2x margins(2) + 1x splitter(2) = 14
      const room = bodyRect.width - 14 - 120;
      w = Math.min(Math.max(w, limits[0]), Math.max(limits[0], room), limits[1]);
      setSplitLeft(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      splitter.classList.remove("dragging");
      document.body.classList.remove("resizing");
      saveSplitSizes();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  splitter.addEventListener("dblclick", () => {
    setSplitLeft(SPLIT_DEFAULTS.left);
    saveSplitSizes();
  });
}

function initBottomSplitter() {
  const splitter = $("split-bottom");
  const col = $("main-col");
  const limits = SPLIT_LIMITS.bottom;

  splitter.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.classList.add("dragging");
    document.body.classList.add("resizing-h");
    const grab = e.clientY - (splitter.getBoundingClientRect().top + 1);

    const onMove = (ev: MouseEvent) => {
      // bottom height from the cursor: the handle center is 2px (splitter
      // margin) + 1px (half splitter) above the panel top
      const colRect = col.getBoundingClientRect();
      let h = colRect.bottom - (ev.clientY - grab) - 3;
      h = Math.min(Math.max(h, limits[0]), limits[1]);
      setSplitBottom(h);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      splitter.classList.remove("dragging");
      document.body.classList.remove("resizing-h");
      saveSplitSizes();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  splitter.addEventListener("dblclick", () => {
    setSplitBottom(SPLIT_DEFAULTS.bottom);
    saveSplitSizes();
  });
}

const savedSplits = loadSplitSizes();
if (savedSplits.left) setSplitLeft(savedSplits.left);
if (savedSplits.bottom) setSplitBottom(savedSplits.bottom);
initLeftSplitter();
initBottomSplitter();

// ------------------------------------------------- input box resize handle
// Drag #input-resize upward to enlarge the chat input box (min 90px, max 60%
// of the chat view height); double-click resets it to the default 130px.
const INPUT_DEFAULT = 130;
const INPUT_MIN = 90;
const INPUT_MAX = 400;

function setInputHeight(h: number) { ($("input-zone") as HTMLElement).style.height = `${h}px`; }

function initInputResize() {
  const handle = $("input-resize");
  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.classList.add("dragging");
    document.body.classList.add("resizing-h");
    const grab = e.clientY - handle.getBoundingClientRect().top;

    const onMove = (ev: MouseEvent) => {
      const view = $("tab-sessions").getBoundingClientRect();
      let h = view.bottom - (ev.clientY - grab);
      h = Math.min(Math.max(h, INPUT_MIN), Math.max(INPUT_MIN, Math.min(INPUT_MAX, view.height * 0.6)));
      setInputHeight(h);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing-h");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  handle.addEventListener("dblclick", () => {
    ($("input-zone") as HTMLElement).style.height = `${INPUT_DEFAULT}px`;
  });
}
initInputResize();

// ------------------------------------------------------------------- boot
// The backend-down state is a NON-BLOCKING chip at the left end of the status
// bar (it used to be a full-width banner over the toolbar, which hid the
// Settings button and made the app unusable when the connection was misconfigured).
let backendDown = false;

async function backendDownDetail(): Promise<string> {
  const mode = await window.api.getConnMode().catch(() => "local");
  if (mode === "remote" || mode === "ssh") {
    const c = await window.api.getConnection().catch(() => null);
    if (mode === "ssh" && c?.ssh) return `ssh ${c.ssh.user ? c.ssh.user + "@" : ""}${c.ssh.host}`;
    if (c) return `${c.host}:${c.port}`;
    return mode;
  }
  return "local";
}

function showBackendDown(code: number | null) {
  backendDown = true;
  setBusy(false);
  const chip = $("backend-status");
  void (async () => {
    const mode = await window.api.getConnMode().catch(() => "local");
    const detail = await backendDownDetail();
    const action = mode === "local" ? "restart the backend" : "reconnect / change the connection";
    chip.textContent = `Backend down (${detail}) — ${action}`;
    chip.title = mode === "local"
      ? `Backend process exited (code=${code}).\nClick to restart the backend.`
      : `Cannot connect to the agent server at ${detail}.\nClick to open Settings > Remote server (the GUI keeps retrying in the background).`;
    chip.classList.remove("hidden");
  })();
}

function clearBackendDown() {
  if (!backendDown) return;
  backendDown = false;
  $("backend-status").classList.add("hidden");
}

// chip click: local mode restarts the bundled backend; remote/ssh opens
// Settings > Remote server (the dialog opens instantly even while the backend
// is down, so the address/port can be fixed from here - matches the tooltip)
$("backend-status").addEventListener("click", async () => {
  const mode = await window.api.getConnMode().catch(() => "local");
  if (mode !== "local") {
    const detail = await backendDownDetail();
    chat.line(`\n[backend down: cannot reach ${detail}; the GUI keeps retrying in the background.]`, "c-warn");
    void settingsDialog("connection").then((saved) => { if (saved) { refreshConnLabel(); chat.line("\n[settings saved]", "c-ok"); } });
    return;
  }
  // remove the chip first: while the restart is in flight the main process
  // sends "backend-url", and the onBackendUrl listener must not race with us
  clearBackendDown();
  try {
    await window.api.restartBackend(S.root);
  } catch (e) {
    showBackendDown(null);
    return;
  }
  // S.root is null when the first start failed (no project was ever opened);
  // the main process may have started the backend with the last project instead
  const r = S.root || S.pendingRoot || (await window.api.getBackendRoot());
  S.pendingRoot = null;
  if (r) await openProject(r);
});

let bootDone = false; // boot() owns backend-exit handling until it finishes

// true while the Settings dialog is open: the background reconnect loop must
// not flash the backend-down chip or re-open the project (wiping the views)
// while the user is editing the connection fields.
let settingsOpen = false;
let reopenPending = false; // a re-open is deferred until the dialog closes

window.api.onConnError((msg) => {
  if (!settingsOpen) chat.line(`\n[connection] ${msg}`, "c-error");
});
void window.api.getConnError().then((msg) => { if (msg) chat.line(`\n[connection] ${msg}`, "c-error"); });

window.api.onBackendExit((code) => {
  if (backendDown || !bootDone) return;
  if (settingsOpen) {
    // the user is fixing the connection in the dialog: no chip, no noise
    return;
  }
  chat.line(`\n[backend exited (code=${code})]`, "c-error");
  showBackendDown(code);
});

// last backend URL we (re)connected to: a change means a new backend process /
// server (boot, restart, local<->remote switch), so the current project must
// be re-opened on it (the server-side engine does not survive a switch).
let lastBackendUrl: string | null = null;

// true once boot() has finished re-opening the project; until then the
// global backend-url listener must not race with the boot's own openProject.
let bootProjectDone = false;

// pick the project to (re)open: the remembered last project, then the one
// queued while the backend was down, then whatever the main process started
// with. In remote mode a remembered "local" project (path on this machine)
// cannot be auto-opened: the server lives on another machine.
async function resolveProjectRoot(): Promise<string | null> {
  const last = lastProjectName();
  const savedLast = last ? loadProjects().find((p) => p.name === last) : null;
  const cm = await window.api.getConnMode().catch(() => "local");
  const remoteConn = cm === "remote" || cm === "ssh";
  let root: string | null = null;
  if (savedLast && (!remoteConn || savedLast.mode === "remote")) root = savedLast.path;
  if (!root) root = S.pendingRoot;
  if (!root) root = await window.api.getLastProject();
  if (!root) root = await window.api.getBackendRoot();
  S.pendingRoot = null;
  return root;
}

// the backend (re)connected: keep the remote indicator in sync, and if the
// banner is up (or the connection URL changed) re-open the project on the new
// backend so a local<->remote switch restores the working session.
window.api.onBackendUrl(async (url: string) => {
  void refreshRemoteLabel();
  if (!bootDone || !bootProjectDone) return; // boot() opens the first project itself
  const urlChanged = url !== lastBackendUrl;
  lastBackendUrl = url;
  if (!backendDown && !urlChanged) return;
  clearBackendDown();
  if (settingsOpen) {
    // the Settings dialog is up (user is fixing the connection): defer the
    // project re-open until it closes, so the views are not wiped mid-edit
    reopenPending = true;
    return;
  }
  const r = S.root || (await resolveProjectRoot());
  if (!r) { $("state-label").textContent = "Connected"; return; }
  await openProject(r);
  // a turn may have kept running on the server while the link was down
  if (S.root) {
    const t = await call("session_turns");
    const running = !t?.__error && (t.turns as any[]).some((x) => x.status === "running");
    if (running) {
      chat.line("\n[connection restored - a task is still running on the server]", "c-ok");
      setState("running_tool", "task running on the server");
    }
  }
});

(async function boot() {
  // from here on, backend-exit / backend-url are handled by the global
  // listeners (banner etc.), so bootDone is set before the first await
  bootDone = true;
  // version shown at the right end of the status bar
  window.api.getAppVersion().then((v) => { $("version-label").textContent = `v${v}`; }).catch(() => {});
  $("state-label").textContent = "Starting backend...";
  // the page loads before the Python backend is up: wait for the "backend-url"
  // event (or the "backend-exit" / timeout if it failed to start).
  const url = await new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (u: string | null) => { if (!done) { done = true; resolve(u); } };
    window.api.onBackendUrl(finish);
    window.api.onBackendExit(() => finish(null));
    setTimeout(() => finish(null), 35000); // slightly past main's 30s start timeout
    // snapshot: covers the case where the backend was already ready and the
    // event was sent before this listener was registered
    window.api.getBackendUrl().then((u) => u && finish(u));
  });
  if (!url) {
    showBackendDown(null);
    $("state-label").textContent = "Backend not running";
    bootProjectDone = true;
    return;
  }
  lastBackendUrl = url; // the global listener must not re-open for this connection
  // reopen the last project by its remembered name (falls back to the old
  // plain-path record, then to whatever the main process started with)
  const root = await resolveProjectRoot();
  if (root) {
    await openProject(root);
  } else {
    chat.line("No project open yet. Click the Projects button above to choose one.", "c-muted");
    $("state-label").textContent = "No project";
  }
  bootProjectDone = true;
})();
