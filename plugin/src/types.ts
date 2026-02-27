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
  notificationsEnabled: boolean;
  debugLogging: boolean;
  debugLogPath: string;
  autoReconnect: boolean;
  excludePatterns: string[];
  approvalTimeoutSeconds: number;
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
  notificationsEnabled: true,
  debugLogging: false,
  debugLogPath: "live-share-debug.md",
  autoReconnect: true,
  excludePatterns: [],
  approvalTimeoutSeconds: 60,
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
  transferId?: string;
}

export interface FileChunkDataOp {
  type: "chunk-data";
  path: string;
  index: number;
  data: string;
  transferId?: string;
}

export interface FileChunkEndOp {
  type: "chunk-end";
  path: string;
  transferId?: string;
}

export interface FileChunkResumeOp {
  type: "chunk-resume";
  path: string;
  transferId: string;
  receivedSeqs: number[];
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
  | FileChunkResumeOp
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
  transferId?: string;
}

export interface ChunkDataMessage {
  type: "file-chunk-data";
  path: string;
  index: number;
  data: string;
  transferId?: string;
}

export interface ChunkEndMessage {
  type: "file-chunk-end";
  path: string;
  transferId?: string;
}

export interface ChunkResumeMessage {
  type: "file-chunk-resume";
  path: string;
  transferId: string;
  receivedSeqs: number[];
}

export interface PresenceUpdateMessage {
  type: "presence-update";
  userId: string;
  displayName: string;
  cursorColor: string;
  currentFile: string;
  avatarUrl?: string;
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
  verified?: boolean;
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

export interface SetFilePermissionMessage {
  type: "set-file-permission";
  userId: string;
  filePath: string;
  permission: Permission;
}

export interface FilePermissionUpdateMessage {
  type: "file-permission-update";
  filePath: string;
  permission: Permission;
}

export interface HostTransferOfferMessage {
  type: "host-transfer-offer";
  userId: string;
  displayName?: string;
}

export interface HostTransferAcceptMessage {
  type: "host-transfer-accept";
  userId: string;
}

export interface HostTransferDeclineMessage {
  type: "host-transfer-decline";
  userId: string;
  displayName?: string;
}

export interface HostTransferCompleteMessage {
  type: "host-transfer-complete";
  userId: string;
  displayName: string;
}

export interface HostDisconnectedMessage {
  type: "host-disconnected";
}

export interface HostChangedMessage {
  type: "host-changed";
  userId: string;
  displayName: string;
}

export type ControlMessage =
  | FileOpMessage
  | ChunkStartMessage
  | ChunkDataMessage
  | ChunkEndMessage
  | ChunkResumeMessage
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
  | SessionEndMessage
  | PingMessage
  | PongMessage
  | SetFilePermissionMessage
  | FilePermissionUpdateMessage
  | HostTransferOfferMessage
  | HostTransferAcceptMessage
  | HostTransferDeclineMessage
  | HostTransferCompleteMessage
  | HostDisconnectedMessage
  | HostChangedMessage;

export type ControlMessageType = ControlMessage["type"];

export interface ControlMessageMap {
  "file-op": FileOpMessage;
  "file-chunk-start": ChunkStartMessage;
  "file-chunk-data": ChunkDataMessage;
  "file-chunk-end": ChunkEndMessage;
  "file-chunk-resume": ChunkResumeMessage;
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
  "session-end": SessionEndMessage;
  ping: PingMessage;
  pong: PongMessage;
  "host-transfer-offer": HostTransferOfferMessage;
  "host-transfer-accept": HostTransferAcceptMessage;
  "host-transfer-decline": HostTransferDeclineMessage;
  "host-transfer-complete": HostTransferCompleteMessage;
  "host-disconnected": HostDisconnectedMessage;
  "host-changed": HostChangedMessage;
  "set-file-permission": SetFilePermissionMessage;
  "file-permission-update": FilePermissionUpdateMessage;
}
