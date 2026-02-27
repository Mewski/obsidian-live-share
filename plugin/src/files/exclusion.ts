import { minimatch } from "minimatch";

const DEFAULT_EXCLUDES = [".obsidian/**", ".trash/**"];

export class ExclusionManager {
  private patterns: string[] = [...DEFAULT_EXCLUDES];

  setPatterns(custom: string[]): void {
    this.patterns = [...DEFAULT_EXCLUDES, ...custom];
  }

  isExcluded(path: string): boolean {
    return this.patterns.some((pattern) => minimatch(path, pattern));
  }
}
