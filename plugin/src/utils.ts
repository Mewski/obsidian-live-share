export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, "ws");
}
