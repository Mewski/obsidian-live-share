import type { Vault } from "obsidian";

const FLUSH_DELAY_MS = 500;

function stringifyError(err: unknown): string {
  if (err === undefined || err === null) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean") return String(err);
  try {
    return JSON.stringify(err);
  } catch {
    return "[unserializable error]";
  }
}

export class DebugLogger {
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private vault: Vault,
    private logPath: string,
    private enabled: boolean,
  ) {}

  updateSettings(enabled: boolean, logPath: string): void {
    this.enabled = enabled;
    this.logPath = logPath;
  }

  log(category: string, message: string): void {
    if (!this.enabled) return;
    this.appendLine("INFO", category, message);
  }

  error(category: string, message: string, err?: unknown): void {
    if (!this.enabled) return;
    const suffix = stringifyError(err);
    this.appendLine("ERROR", category, suffix ? `${message}: ${suffix}` : message);
  }

  private appendLine(level: string, category: string, message: string): void {
    const ts = new Date().toISOString();
    this.buffer.push(`${ts} [${level}] [${category}] ${message}`);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DELAY_MS);
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const lines = `${this.buffer.join("\n")}\n`;
    this.buffer = [];
    this.vault.adapter.append(this.logPath, lines).catch(() => {
      // Best-effort logging, discard write failures
    });
  }

  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}
