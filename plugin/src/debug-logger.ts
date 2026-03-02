import type { Vault } from "obsidian";

const FLUSH_DELAY_MS = 500;

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
    const errStr =
      err instanceof Error
        ? `: ${err.message}`
        : err
          ? `: ${typeof err === "object" ? JSON.stringify(err) : String(err)}`
          : "";
    this.appendLine("ERROR", category, `${message}${errStr}`);
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
