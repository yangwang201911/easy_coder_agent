// A small modal window with text / password fields. dialog.showMessageBox cannot take input,
// so the ssh target and password prompts use this instead.
import { BrowserWindow, ipcMain } from "electron";
import * as path from "node:path";

export interface PromptField {
  id: string;
  label: string;
  type?: "text" | "password";
  value?: string;
  placeholder?: string;
  optional?: boolean;
  advanced?: boolean; // shown under a collapsed "Advanced" section
}
export interface PromptSpec {
  title: string;
  message?: string;
  error?: string;
  okLabel?: string;
  fields: PromptField[];
}

interface Pending { spec: PromptSpec; win: BrowserWindow; resolve: (v: Record<string, string> | null) => void; }
const pending = new Map<number, Pending>(); // keyed by webContents id
let registered = false;

function register() {
  if (registered) return;
  registered = true;
  const of = (e: Electron.IpcMainInvokeEvent) => pending.get(e.sender.id);
  ipcMain.handle("prompt-spec", (e) => of(e)?.spec ?? null);
  ipcMain.handle("prompt-submit", (e, values: Record<string, string>) => {
    const p = of(e);
    if (!p) return;
    pending.delete(e.sender.id);
    p.resolve(values);
    if (!p.win.isDestroyed()) p.win.close();
  });
  ipcMain.handle("prompt-cancel", (e) => { const p = of(e); if (p && !p.win.isDestroyed()) p.win.close(); });
  ipcMain.handle("prompt-resize", (e, h: number) => {
    const p = of(e);
    if (!p || p.win.isDestroyed()) return;
    p.win.setContentSize(460, Math.max(120, Math.min(Math.round(h), 600)));
    if (!p.win.isVisible()) p.win.show();
  });
}

// Resolves with the field values, or null when the user cancels / closes the window.
export function showPrompt(parent: BrowserWindow | null, spec: PromptSpec): Promise<Record<string, string> | null> {
  register();
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 460,
      height: 240,
      show: false,
      parent: parent ?? undefined,
      modal: !!parent,
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      title: spec.title,
      webPreferences: {
        preload: path.join(__dirname, "../preload/prompt.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.setMenu(null);
    const id = win.webContents.id;
    pending.set(id, { spec, win, resolve });
    win.on("closed", () => {
      const p = pending.get(id);
      if (p) { pending.delete(id); p.resolve(null); }
    });
    void win.loadFile(path.join(__dirname, "../renderer/prompt.html"));
  });
}
