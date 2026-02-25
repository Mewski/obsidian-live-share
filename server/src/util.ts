import { createHmac, timingSafeEqual } from "node:crypto";

const COMPARE_KEY = "live-share-token-compare";

export function safeTokenCompare(actual: string, expected: string): boolean {
  const hmacActual = createHmac("sha256", COMPARE_KEY).update(actual).digest();
  const hmacExpected = createHmac("sha256", COMPARE_KEY).update(expected).digest();
  return timingSafeEqual(hmacActual, hmacExpected);
}
