/**
 * Room CRUD, token validation, and TTL-based cleanup.
 *
 * Manages in-memory room state backed by LevelDB persistence. Rooms are
 * created with a host token and cleaned up after a configurable TTL of inactivity.
 */

import { Router } from "express";
import { nanoid } from "nanoid";

import { type Persistence, type Room, noopPersistence } from "./persistence.js";
import { safeTokenCompare } from "./util.js";

export type { Room };

const ROOM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const rooms = new Map<string, Room>();
let _persistence: Persistence = noopPersistence;

export async function initRooms(persistence: Persistence) {
  _persistence = persistence;
  const stored = await persistence.loadRooms();
  const now = Date.now();
  for (const room of stored) {
    const age = now - (room.lastActivityAt || room.createdAt);
    if (age > ROOM_MAX_AGE_MS) {
      await persistence.deleteRoom(room.id);
      continue;
    }
    rooms.set(room.id, room);
  }
}

export function touchRoom(id: string) {
  const room = rooms.get(id);
  if (room) {
    room.lastActivityAt = Date.now();
    _persistence.saveRoom(room).catch((err) => {
      console.error(`touchRoom persist error for ${id}:`, err);
    });
  }
}

export async function removeRoom(id: string) {
  rooms.delete(id);
  try {
    await _persistence.deleteRoom(id);
  } catch (err) {
    console.error(`removeRoom persist error for ${id}:`, err);
  }
}

export async function reapStaleRooms() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const age = now - (room.lastActivityAt || room.createdAt);
    if (age > ROOM_MAX_AGE_MS) {
      rooms.delete(id);
      try {
        await _persistence.deleteRoom(id);
      } catch (err) {
        console.error(`reapStaleRooms persist error for ${id}:`, err);
      }
    }
  }
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id);
}

export const roomRouter = Router();

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional -- validates user input
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

roomRouter.post("/", async (req, res) => {
  const rawName = req.body.name;
  const name = typeof rawName === "string" && rawName.length > 0 ? rawName : `session-${nanoid(6)}`;
  if (name.length > 100 || CONTROL_CHARS.test(name)) {
    res.status(400).json({ error: "invalid name" });
    return;
  }

  const hostUserId = typeof req.body.hostUserId === "string" ? req.body.hostUserId : undefined;
  if (hostUserId && (hostUserId.length > 128 || CONTROL_CHARS.test(hostUserId))) {
    res.status(400).json({ error: "invalid hostUserId" });
    return;
  }

  const now = Date.now();
  const room: Room = {
    id: nanoid(12),
    token: nanoid(24),
    name,
    createdAt: now,
    lastActivityAt: now,
    hostUserId,
  };
  rooms.set(room.id, room);
  await _persistence.saveRoom(room);

  res.status(201).json({ id: room.id, token: room.token, name: room.name });
});

roomRouter.post("/:id/join", (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return;
  }

  const { token } = req.body;
  if (!token || !safeTokenCompare(token, room.token)) {
    res.status(403).json({ error: "invalid token" });
    return;
  }

  res.json({ id: room.id, name: room.name, wsUrl: `/ws/${room.id}` });
});

roomRouter.get("/:id", (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return;
  }

  res.json({ name: room.name, createdAt: room.createdAt });
});

roomRouter.delete("/:id", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing token" });
    return;
  }

  const token = auth.slice(7);
  const room = rooms.get(req.params.id);
  if (!room) {
    res.status(404).json({ error: "room not found" });
    return;
  }

  if (!safeTokenCompare(token, room.token)) {
    res.status(403).json({ error: "invalid token" });
    return;
  }

  rooms.delete(req.params.id);
  await _persistence.deleteRoom(req.params.id);

  res.json({ ok: true });
});
