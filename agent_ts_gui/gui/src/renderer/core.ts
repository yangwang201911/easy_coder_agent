// Coder Agent GUI - shared core: DOM helpers, markdown, panes, state, RPC client.
import markdownit from "markdown-it";
import DOMPurify from "dompurify";
import type { ReplyMsg, AgentEvent } from "../types";

// ------------------------------------------------------ markdown (chat only)
export const md = markdownit({ html: false, linkify: true, breaks: true });
export function renderMarkdown(el: HTMLElement, text: string) {
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
export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ------------------------------------------------------------------- theme
export const THEME_KEY = "agent_ts_gui.theme";
export const THEMES = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "solarized", label: "Solarized Light" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];

export function currentTheme(): ThemeId {
  const t = localStorage.getItem(THEME_KEY);
  return THEMES.some((x) => x.id === t) ? (t as ThemeId) : "light";
}
export function applyTheme(id: ThemeId) {
  if (id === "light") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
}
applyTheme(currentTheme());

export function short(text: string, n: number): string {
  const t = String(text).replace(/\s+/g, " ");
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

export function argsSummary(name: string, args: Record<string, any>): string {
  if (name === "run_command") return String(args.command ?? "");
  if (name === "read_file" || name === "list_dir" || name === "write_file" || name === "apply_patch") {
    let extra = "";
    if (name === "read_file" && args.start_line) extra = ` [${args.start_line}-${args.end_line ?? ""}]`;
    return String(args.path ?? ".") + extra;
  }
  return short(JSON.stringify(args), 140);
}

export function fmtTok(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}k` : String(Math.round(n));
}

// log panes: append-only, stick to the bottom while the user is at the bottom
export class Pane {
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
export function toggleBlock(span: HTMLElement, full: string, clsName: string) {
  if (span.dataset.full === undefined) { span.dataset.full = full; span.dataset.cls = clsName; }
  const expanded = span.classList.toggle("expanded");
  span.textContent = expanded ? span.dataset.full : short(span.dataset.full, 160);
  span.classList.toggle("c-muted", !expanded && span.dataset.cls !== "c-error");
  const saved = span.dataset.cls;
  if (saved) span.classList.toggle(saved, expanded);
}

// streaming markdown block: keeps the raw text, re-renders the whole block
// (throttled to one frame) so partial code fences self-correct as deltas arrive
export class MdBlock {
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

export const chat = new Pane($("chat"));
export const activity = new Pane($("tab-activity"));
export const thinking = new Pane($("tab-thinking"));
export const commands = new Pane($("tab-commands"));
export const planView = $("tab-plan");

// ------------------------------------------------------------------- state
export const S = {
  root: null as string | null,
  pendingRoot: null as string | null, // project picked while the backend was not ready
  taskTypes: [] as string[],
  effort: "medium",
  efforts: [] as string[], // effort values the server accepts (empty = not probed yet)
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
  permMode: "default" as string, // permission mode: default | accept_edits | plan | bypass
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

export function call(method: string, params: Record<string, any> = {}, opts: { waitReady?: boolean; timeoutMs?: number } = {}): Promise<any> {
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

// -------------------------------------------
// event log
export function stampOf(epochSec: number): string {
  const ts = new Date(epochSec * 1000);
  return `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}`;
}
export function log(ev: AgentEvent, text: string, cls = "") {
  activity.line(`${stampOf(ev.ts)} [${ev.agent_id}] ${ev.event}: ${short(text, 220)}`, cls, true);
}

// html escape
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
