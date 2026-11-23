// Shared types for the Electron <-> Python backend protocol.

export interface AgentEvent {
  event: string;
  agent_id: string;
  data: Record<string, any>;
  ts: number;
}

export interface ReplyMsg {
  id: number;
  result?: any;
  error?: string;
}

export interface Api {
  getBackendUrl: () => Promise<string | null>;
  getBackendRoot: () => Promise<string | null>;
  getAppVersion: () => Promise<string>;
  onBackendUrl: (cb: (url: string) => void) => void;
  onBackendExit: (cb: (code: number | null) => void) => void;
  send: (payload: object) => Promise<void>;
  onReply: (cb: (msg: ReplyMsg) => void) => void;
  onEvent: (cb: (ev: AgentEvent) => void) => void;
  pickDirectory: () => Promise<string | null>;
  pickFiles: () => Promise<string[]>;
  pickImages: () => Promise<{ name: string; data_url: string }[]>;
  webCapture: (url: string) => Promise<{ data_url?: string; error?: string }>;
  readFile: (p: string) => Promise<{ content?: string; error?: string }>;
  getLastProject: () => Promise<string | null>;
  setLastProject: (p: string) => Promise<void>;
  restartBackend: (root: string | null) => Promise<void>;
  getConnection: () => Promise<Connection>;
  getConnMode: () => Promise<"local" | "remote" | "ssh">;
  setConnection: (c: Connection & { root?: string | null }) => Promise<{ ok: boolean; reconnected?: boolean; url?: string; error?: string }>;
  sshConnect: (o: { token?: string; root?: string | null }) => Promise<{ ok: boolean; reconnected?: boolean; url?: string; error?: string }>;
  getConnError: () => Promise<string>;
  onConnError: (cb: (msg: string) => void) => void;
  winMinimize: () => Promise<void>;
  winToggleMaximize: () => Promise<boolean>;
  winIsMaximized: () => Promise<boolean>;
  winClose: () => Promise<void>;
}

export interface SshTarget {
  host: string;
  user: string;
  port: number;        // ssh port, 0 = default 22
  identity: string;    // identity file path, "" = ssh agent; password is prompted in a dialog if the server asks
  remotePort: number;  // coder-agent-server port on the remote machine
}

export interface Connection {
  mode: "local" | "remote" | "ssh";
  host: string;
  port: number;
  token: string;
  ssh?: SshTarget;
}

declare global {
  interface Window {
    api: Api;
  }
}

export {};
