import type { Vault, TFile } from "obsidian";
import { minimatch } from "minimatch";

export interface LiveShareConfig {
  exclude: string[];
}

const DEFAULT_EXCLUDES = [".obsidian/**", ".liveshare.json", ".trash/**"];

export class ExclusionManager {
  private patterns: string[] = [...DEFAULT_EXCLUDES];

  async loadConfig(vault: Vault): Promise<void> {
    try {
      const file = vault.getAbstractFileByPath(".liveshare.json");
      if (file && "stat" in file) {
        const content = await vault.read(file as TFile);
        const config = JSON.parse(content) as LiveShareConfig;
        if (Array.isArray(config.exclude)) {
          this.patterns = [...DEFAULT_EXCLUDES, ...config.exclude];
        }
      }
    } catch {
      // Use defaults
    }
  }

  isExcluded(path: string): boolean {
    return this.patterns.some((pattern) => minimatch(path, pattern));
  }

  isIncluded(path: string): boolean {
    return !this.isExcluded(path);
  }
}
