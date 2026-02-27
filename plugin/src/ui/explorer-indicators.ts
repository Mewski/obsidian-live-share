export class ExplorerIndicators {
  private currentPaths = new Set<string>();

  update(readOnlyPaths: string[]): void {
    const newPaths = new Set(readOnlyPaths);

    for (const path of this.currentPaths) {
      if (!newPaths.has(path)) {
        this.setIndicator(path, false);
      }
    }
    for (const path of newPaths) {
      this.setIndicator(path, true);
    }
    this.currentPaths = newPaths;
  }

  destroy(): void {
    for (const path of this.currentPaths) {
      this.setIndicator(path, false);
    }
    this.currentPaths.clear();
  }

  private setIndicator(path: string, active: boolean): void {
    const el = document.querySelector(`.nav-file[data-path="${CSS.escape(path)}"]`);
    if (!el) return;
    if (active) {
      el.addClass("live-share-readonly");
    } else {
      el.removeClass("live-share-readonly");
    }
  }
}
