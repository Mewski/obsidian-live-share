import { Level } from "level";

export type Permission = "read-write" | "read-only";
export interface Room {
  id: string;
  token: string;
  name: string;
  createdAt: number;
  lastActivityAt: number;
  hostUserId?: string;
  requireApproval?: boolean;
  readOnlyPatterns?: string[];
  defaultPermission?: Permission;
}

export interface Persistence {
  loadRooms(): Promise<Room[]>;
  saveRoom(room: Room): Promise<void>;
  deleteRoom(id: string): Promise<void>;
  close(): Promise<void>;
}

export function createLevelPersistence(dbPath = "./data/yjs-docs"): Persistence {
  const db = new Level(dbPath, { valueEncoding: "buffer" });

  return {
    async loadRooms(): Promise<Room[]> {
      const rooms: Room[] = [];
      try {
        for await (const [key, value] of db.iterator<string, Buffer>({
          keyEncoding: "utf8",
        })) {
          if (key.startsWith("room:")) {
            try {
              rooms.push(JSON.parse(value.toString("utf-8")));
            } catch (err) {
              console.warn("[persistence] corrupt room entry, skipping:", key, err);
            }
          }
        }
      } catch (err) {
        console.warn("[persistence] failed to load rooms:", err);
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
  async loadRooms() {
    return [];
  },
  async saveRoom() {},
  async deleteRoom() {},
  async close() {},
};

let defaultPersistence: Persistence | null = null;

export function getDefaultPersistence(): Persistence {
  if (!defaultPersistence) {
    defaultPersistence = createLevelPersistence();
  }
  return defaultPersistence;
}
