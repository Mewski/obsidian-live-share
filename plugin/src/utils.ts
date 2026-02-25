import { TFolder, type Vault } from "obsidian";

export const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n|\r/g, "\n");
}

export function applyMinimalYTextUpdate(
  doc: { transact: (fn: () => void) => void },
  text: {
    toString: () => string;
    delete: (pos: number, len: number) => void;
    insert: (pos: number, s: string) => void;
    length: number;
  },
  newContent: string,
): void {
  const oldContent = text.toString();
  if (oldContent === newContent) return;

  let prefix = 0;
  const minLen = Math.min(oldContent.length, newContent.length);
  while (prefix < minLen && oldContent[prefix] === newContent[prefix]) prefix++;

  let oldSuffix = oldContent.length;
  let newSuffix = newContent.length;
  while (
    oldSuffix > prefix &&
    newSuffix > prefix &&
    oldContent[oldSuffix - 1] === newContent[newSuffix - 1]
  ) {
    oldSuffix--;
    newSuffix--;
  }

  doc.transact(() => {
    if (oldSuffix > prefix) text.delete(prefix, oldSuffix - prefix);
    if (newSuffix > prefix) text.insert(prefix, newContent.slice(prefix, newSuffix));
  });
}

export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, "ws");
}

const TEXT_EXTENSIONS = new Set([
  "md",
  "txt",
  "json",
  "css",
  "js",
  "ts",
  "jsx",
  "tsx",
  "html",
  "xml",
  "yaml",
  "yml",
  "csv",
  "svg",
  "tex",
  "latex",
  "bib",
  "org",
  "rst",
  "adoc",
  "canvas",
  "mermaid",
  "graphql",
  "toml",
  "ini",
  "cfg",
  "conf",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "py",
  "rb",
  "rs",
  "go",
  "java",
  "kt",
  "scala",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "swift",
  "r",
  "lua",
  "sql",
  "scss",
  "sass",
  "less",
  "styl",
  "vue",
  "svelte",
]);

export function isTextFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i;
const WINDOWS_INVALID_CHARS = /[<>:"|?*]/;

export function getPathWarning(path: string): string | null {
  const segments = path.split("/");
  for (const seg of segments) {
    if (!seg) continue;
    if (WINDOWS_INVALID_CHARS.test(seg)) {
      return `"${seg}" contains characters not allowed on Windows`;
    }
    const name = seg.replace(/\.[^.]*$/, "");
    if (WINDOWS_RESERVED.test(name)) {
      return `"${seg}" is a reserved filename on Windows`;
    }
    if (seg.endsWith(".") || seg.endsWith(" ")) {
      return `"${seg}" ends with a dot or space, which fails on Windows`;
    }
  }
  return null;
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer as ArrayBuffer;
}

export async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFolder) return;
  const parts = path.split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const folder = vault.getAbstractFileByPath(current);
    if (!folder) {
      try {
        await vault.createFolder(current);
      } catch {}
    }
  }
}
