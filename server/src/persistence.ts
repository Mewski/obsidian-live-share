import { Level } from "level";
import * as Y from "yjs";

export type Permission = "read-write" | "read-only";
export type ApprovalStatus = "approved" | "pending" | "denied";

export interface RoomParticipant {
  githubUserId: string;
  displayName: string;
  avatarUrl: string;
  role: "host" | "guest";
  permission: Permission;
  status: ApprovalStatus;
  joinedAt: number;
}

export interface Room {
  id: string;
  token: string;
  name: string;
  createdAt: number;
  hostUserId?: string;
  requireApproval?: boolean;
  defaultPermission?: Permission;
  participants?: RoomParticipant[];
}

export interface Persistence {
  loadDoc(docName: string, doc: Y.Doc): Promise<void>;
  persistDoc(docName: string, doc: Y.Doc): Promise<void>;
  loadRooms(): Promise<Room[]>;
  saveRoom(room: Room): Promise<void>;
  deleteRoom(id: string): Promise<void>;
  close(): Promise<void>;
}

export function createLevelPersistence(dbPath = "./data/yjs-docs"): Persistence {
  const db = new Level(dbPath, { valueEncoding: "buffer" });

  return {
    async loadDoc(docName: string, doc: Y.Doc): Promise<void> {
      try {
        const stored = await db.get(`doc:${docName}`);
        const update = new Uint8Array(stored as unknown as ArrayBuffer);
        Y.applyUpdate(doc, update);
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "LEVEL_NOT_FOUND") {
          return;
        }
        throw err;
      }
    },

    async persistDoc(docName: string, doc: Y.Doc): Promise<void> {
      const update = Y.encodeStateAsUpdate(doc);
      await db.put(`doc:${docName}`, Buffer.from(update) as unknown as string);
    },

    async loadRooms(): Promise<Room[]> {
      const rooms: Room[] = [];
      try {
        for await (const [key, value] of db.iterator<string, Buffer>({
          keyEncoding: "utf8",
        })) {
          if (key.startsWith("room:")) {
            rooms.push(JSON.parse(value.toString("utf-8")));
          }
        }
      } catch {
        // DB may be empty
      }
      return rooms;
    },

    async saveRoom(room: Room): Promise<void> {
      await db.put(`room:${room.id}`, Buffer.from(JSON.stringify(room)) as unknown as string);
    },

    async deleteRoom(id: string): Promise<void> {
      try {
        await db.del(`room:${id}`);
      } catch (err: unknown) {
        if ((err as { code?: string }).code !== "LEVEL_NOT_FOUND") throw err;
      }
    },

    async close(): Promise<void> {
      await db.close();
    },
  };
}

export const noopPersistence: Persistence = {
  async loadDoc() {},
  async persistDoc() {},
  async loadRooms() {
    return [];
  },
  async saveRoom() {},
  async deleteRoom() {},
  async close() {},
};

let _defaultPersistence: Persistence | null = null;

export function getDefaultPersistence(): Persistence {
  if (!_defaultPersistence) {
    _defaultPersistence = createLevelPersistence();
  }
  return _defaultPersistence;
}
