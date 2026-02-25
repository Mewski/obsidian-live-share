/**
 * File exclusion patterns loaded from `.liveshare.json`.
 *
 * Merges user-defined glob patterns with built-in defaults (.obsidian/**,
 * .liveshare.json, .trash/**) and tests paths against the combined set.
 */
import { minimatch } from "minimatch";
import { Notice } from "obsidian";
import type { TFile, Vault } from "obsidian";

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
      new Notice("Live Share: .liveshare.json has invalid syntax");
    }
  }

  isExcluded(path: string): boolean {
    return this.patterns.some((pattern) => minimatch(path, pattern));
  }
}
