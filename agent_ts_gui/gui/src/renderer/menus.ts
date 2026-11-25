// Coder Agent GUI - context menu + prompt/confirm modals.
import { $ } from "./core";

// ------------------------------------------------- context menu + modal
export function showMenu(x: number, y: number, items: { label: string; enabled?: boolean; fn?: () => void }[]) {
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
export function promptModal(title: string, initial: string): Promise<string | null> {
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

export function confirmModal(title: string, text: string): Promise<boolean> {
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

export function editPromptModal(title: string, info: string, prompt: string): Promise<{ prompt: string; keepBranch: boolean } | null> {
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