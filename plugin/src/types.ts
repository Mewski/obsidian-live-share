export type SessionRole = "host" | "guest" | null;

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

export type FileOp =
  | FileCreateOp
  | FileModifyOp
  | FileDeleteOp
  | FileRenameOp
  | FileChunkStartOp
  | FileChunkDataOp
  | FileChunkEndOp;
