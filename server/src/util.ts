import { createHmac, timingSafeEqual } from "node:crypto";

const COMPARE_KEY = "live-share-token-compare";

export function safeTokenCompare(a: string, b: string): boolean {
  const ha = createHmac("sha256", COMPARE_KEY).update(a).digest();
  const hb = createHmac("sha256", COMPARE_KEY).update(b).digest();
  return timingSafeEqual(ha, hb);
}
