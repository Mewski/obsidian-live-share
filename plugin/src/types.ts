export type SessionRole = "host" | "guest" | null;

export type Permission = "read-write" | "read-only";

export interface LiveShareSettings {
  serverUrl: string;
  roomId: string;
  token: string;
  jwt: string;
  githubUserId: string;
  avatarUrl: string;
  displayName: string;
  cursorColor: string;
  sharedFolder: string;
  role: SessionRole;
  encryptionPassphrase: string;
  permission: Permission;
  requireApproval: boolean;
  serverPassword: string;
  clientId: string;
}

export const DEFAULT_SETTINGS: LiveShareSettings = {
  serverUrl: "http://localhost:4321",
  roomId: "",
  token: "",
  jwt: "",
  githubUserId: "",
  avatarUrl: "",
  displayName: "Anonymous",
  cursorColor: "#7c3aed",
  sharedFolder: "",
  role: null,
  encryptionPassphrase: "",
  permission: "read-write",
  requireApproval: false,
  serverPassword: "",
  clientId: "",
};

export interface FileCreateOp {
  type: "create";
  path: string;
  content: string;
  binary?: boolean;
}

export interface FileModifyOp {
  type: "modify";
  path: string;
  content: string;
  binary?: boolean;
}

export interface FileDeleteOp {
  type: "delete";
  path: string;
}

export interface FileRenameOp {
  type: "rename";
  oldPath: string;
  newPath: string;
}

export interface FileChunkStartOp {
  type: "chunk-start";
  path: string;
  totalSize: number;
  binary?: boolean;
}

export interface FileChunkDataOp {
  type: "chunk-data";
  path: string;
  index: number;
  data: string;
}

export interface FileChunkEndOp {
  type: "chunk-end";
  path: string;
}

export interface FolderCreateOp {
  type: "folder-create";
  path: string;
}

export type FileOp =
  | FileCreateOp
  | FileModifyOp
  | FileDeleteOp
  | FileRenameOp
  | FileChunkStartOp
  | FileChunkDataOp
  | FileChunkEndOp
  | FolderCreateOp;

export interface FileOpMessage {
  type: "file-op";
  op: FileOp;
}

export interface ChunkStartMessage {
  type: "file-chunk-start";
  path: string;
  totalSize: number;
  binary?: boolean;
}

export interface ChunkDataMessage {
  type: "file-chunk-data";
  path: string;
  index: number;
  data: string;
}

export interface ChunkEndMessage {
  type: "file-chunk-end";
  path: string;
}

export interface PresenceUpdateMessage {
  type: "presence-update";
  userId: string;
  displayName: string;
  cursorColor: string;
  currentFile: string;
  scrollTop?: number;
  isHost?: boolean;
  line?: number;
  permission?: Permission;
}

export interface PresenceLeaveMessage {
  type: "presence-leave";
  userId: string;
}

export interface JoinRequestMessage {
  type: "join-request";
  userId: string;
  displayName: string;
  avatarUrl: string;
}

export interface JoinResponseMessage {
  type: "join-response";
  userId?: string;
  approved: boolean;
  permission?: Permission;
}

export interface KickMessage {
  type: "kick";
  userId: string;
}

export interface KickedMessage {
  type: "kicked";
}

export interface SetPermissionMessage {
  type: "set-permission";
  userId: string;
  permission: Permission;
}

export interface PermissionUpdateMessage {
  type: "permission-update";
  permission: Permission;
}

export interface FocusRequestMessage {
  type: "focus-request";
  fromUserId: string;
  fromDisplayName: string;
  filePath: string;
  line: number;
  ch: number;
}

export interface SummonMessage {
  type: "summon";
  fromUserId: string;
  fromDisplayName: string;
  targetUserId: string;
  filePath: string;
  line: number;
  ch: number;
}

export interface PresentStartMessage {
  type: "present-start";
  userId: string;
}

export interface PresentStopMessage {
  type: "present-stop";
  userId: string;
}

export interface SyncRequestMessage {
  type: "sync-request";
  path?: string;
}

export interface SyncResponseMessage {
  type: "sync-response";
}

export interface SessionEndMessage {
  type: "session-end";
}

export interface PingMessage {
  type: "ping";
  timestamp: number;
}

export interface PongMessage {
  type: "pong";
  timestamp?: number;
}

export type ControlMessage =
  | FileOpMessage
  | ChunkStartMessage
  | ChunkDataMessage
  | ChunkEndMessage
  | PresenceUpdateMessage
  | PresenceLeaveMessage
  | JoinRequestMessage
  | JoinResponseMessage
  | KickMessage
  | KickedMessage
  | SetPermissionMessage
  | PermissionUpdateMessage
  | FocusRequestMessage
  | SummonMessage
  | PresentStartMessage
  | PresentStopMessage
  | SyncRequestMessage
  | SyncResponseMessage
  | SessionEndMessage
  | PingMessage
  | PongMessage;

export type ControlMessageType = ControlMessage["type"];

export interface ControlMessageMap {
  "file-op": FileOpMessage;
  "file-chunk-start": ChunkStartMessage;
  "file-chunk-data": ChunkDataMessage;
  "file-chunk-end": ChunkEndMessage;
  "presence-update": PresenceUpdateMessage;
  "presence-leave": PresenceLeaveMessage;
  "join-request": JoinRequestMessage;
  "join-response": JoinResponseMessage;
  kick: KickMessage;
  kicked: KickedMessage;
  "set-permission": SetPermissionMessage;
  "permission-update": PermissionUpdateMessage;
  "focus-request": FocusRequestMessage;
  summon: SummonMessage;
  "present-start": PresentStartMessage;
  "present-stop": PresentStopMessage;
  "sync-request": SyncRequestMessage;
  "sync-response": SyncResponseMessage;
  "session-end": SessionEndMessage;
  ping: PingMessage;
  pong: PongMessage;
}
