import { Level } from "level";
import { nanoid } from "nanoid";

export interface AuditEntry {
  timestamp: number;
  event: string;
  userId: string;
  displayName: string;
  details?: string;
}

let db: Level | null = null;

export function initAuditLog(dbPath = "./data/audit"): void {
  db = new Level(dbPath, { valueEncoding: "buffer" });
}

export async function appendLog(roomId: string, entry: AuditEntry): Promise<void> {
  if (!db) return;
  const key = `${roomId}:${entry.timestamp}:${nanoid(6)}`;
  try {
    await db.put(key, Buffer.from(JSON.stringify(entry)) as unknown as string);
  } catch (err) {
    console.error("[audit] failed to write log entry:", err);
  }
}

export async function getLogs(roomId: string, limit = 100): Promise<AuditEntry[]> {
  if (!db) return [];
  const entries: AuditEntry[] = [];
  try {
    for await (const [key, value] of db.iterator<string, Buffer>({
      gte: `${roomId}:`,
      lte: `${roomId}:\xff`,
      keyEncoding: "utf8",
      reverse: true,
      limit,
    })) {
      try {
        entries.push(JSON.parse((value as unknown as Buffer).toString("utf-8")));
      } catch {}
    }
  } catch (err) {
    console.error("[audit] failed to read logs:", err);
  }
  return entries;
}

export async function clearLogs(roomId: string): Promise<void> {
  if (!db) return;
  try {
    const batch = db.batch();
    for await (const [key] of db.iterator<string, Buffer>({
      gte: `${roomId}:`,
      lte: `${roomId}:\xff`,
      keyEncoding: "utf8",
    })) {
      batch.del(key);
    }
    await batch.write();
  } catch (err) {
    console.error("[audit] failed to clear logs:", err);
  }
}

export async function closeAuditLog(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}
