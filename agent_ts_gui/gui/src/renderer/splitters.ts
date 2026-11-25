// Coder Agent GUI - resizable splitters + input box resize handle.
import { $ } from "./core";

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
// of the chat view height); double-click resets it to the natural height
// (the zone grows with its content, e.g. the image attach strip).
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
    const startY = e.clientY;
    const startH = ($("input-zone") as HTMLElement).getBoundingClientRect().height;

    const onMove = (ev: MouseEvent) => {
      const view = $("tab-sessions").getBoundingClientRect();
      let h = startH + (startY - ev.clientY);
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
    // back to the natural (content-sized) height
    ($("input-zone") as HTMLElement).style.height = "";
  });
}
initInputResize();