import { minimatch } from "minimatch";

export class ExclusionManager {
  private patterns: string[] = [];
  private configDir = "";

  setConfigDir(configDir: string): void {
    this.configDir = configDir;
  }

  setPatterns(custom: string[]): void {
    this.patterns = [`${this.configDir}/**`, ".trash/**", ...custom];
  }

  isExcluded(path: string): boolean {
    return this.patterns.some((pattern) => minimatch(path, pattern));
  }
}
