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
};

export interface FileCreateOp {
  type: "create";
  path: string;
  content: string;
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

export type FileOp = FileCreateOp | FileDeleteOp | FileRenameOp;
