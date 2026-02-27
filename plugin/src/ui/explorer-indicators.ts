const STYLE_ID = "live-share-explorer-indicators";

function escapeCssString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\00000a")
    .replace(/\r/g, "\\00000d")
    .replace(/\f/g, "\\00000c");
}

export class ExplorerIndicators {
  private readonly styleEl: HTMLStyleElement;

  constructor() {
    const existing = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    this.styleEl = existing ?? document.createElement("style");
    this.styleEl.id = STYLE_ID;
    if (!existing) document.head.appendChild(this.styleEl);
  }

  update(readOnlyPaths: string[]): void {
    const rules: string[] = [];
    for (const path of readOnlyPaths) {
      const escaped = escapeCssString(path);
      rules.push(
        `.nav-file[data-path="${escaped}"] .nav-file-title-content::after { content: "\\1F512"; font-size: 10px; margin-left: 4px; opacity: 0.7;}`,
      );
    }
    this.styleEl.textContent = rules.join("\n");
  }

  destroy(): void {
    this.styleEl.remove();
  }
}
