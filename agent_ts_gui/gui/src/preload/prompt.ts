// Preload for the small modal prompt window (ssh target / password).
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("promptApi", {
  getSpec: (): Promise<unknown> => ipcRenderer.invoke("prompt-spec"),
  submit: (values: Record<string, string>): Promise<void> => ipcRenderer.invoke("prompt-submit", values),
  cancel: (): Promise<void> => ipcRenderer.invoke("prompt-cancel"),
  resize: (height: number): Promise<void> => ipcRenderer.invoke("prompt-resize", height),
});
