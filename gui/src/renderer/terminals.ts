// Coder Agent GUI - interactive backend terminals (PTY via xterm.js).
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { $, call, chat, activity, thinking, commands, log, S } from "./core";
import { showMenu } from "./menus";

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
  // hide the list column entirely while no terminal is open
  ul.parentElement!.classList.toggle("empty", S_TERM.terms.size === 0);
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

export function onTermEvent(k: string, d: Record<string, any>) {
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
