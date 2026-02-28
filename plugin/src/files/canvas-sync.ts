import { Notice, type Vault } from "obsidian";
import * as Y from "yjs";

import type { SyncManager } from "../sync/sync";
import {
  VAULT_EVENT_SETTLE_MS,
  ensureFolder,
  getFileByPath,
  normalizePath,
  toCanonicalPath,
  toLocalPath,
} from "../utils";
import type { FileOpsManager } from "./file-ops";

const CANVAS_DOC_PREFIX = "__canvas__:";
const DEBOUNCE_MS = 1000;

interface CanvasData {
  nodes: Record<string, Record<string, unknown>>;
  edges: Record<string, Record<string, unknown>>;
}

function parseCanvas(content: string): CanvasData {
  try {
    const parsed = JSON.parse(content);
    const nodes: Record<string, Record<string, unknown>> = {};
    const edges: Record<string, Record<string, unknown>> = {};
    if (Array.isArray(parsed.nodes)) {
      for (const node of parsed.nodes) {
        if (node.id) nodes[node.id] = node;
      }
    }
    if (Array.isArray(parsed.edges)) {
      for (const edge of parsed.edges) {
        if (edge.id) edges[edge.id] = edge;
      }
    }
    return { nodes, edges };
  } catch {
    return { nodes: {}, edges: {} };
  }
}

function serializeCanvas(
  nodesMap: Y.Map<Y.Map<unknown>>,
  edgesMap: Y.Map<Y.Map<unknown>>,
): string {
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];

  for (const [, nodeYMap] of nodesMap) {
    const obj: Record<string, unknown> = {};
    for (const [key, value] of nodeYMap) {
      obj[key] = value;
    }
    nodes.push(obj);
  }

  for (const [, edgeYMap] of edgesMap) {
    const obj: Record<string, unknown> = {};
    for (const [key, value] of edgeYMap) {
      obj[key] = value;
    }
    edges.push(obj);
  }

  return JSON.stringify({ nodes, edges }, null, "\t");
}

function applyToYMap(ymap: Y.Map<unknown>, obj: Record<string, unknown>): void {
  const existingKeys = new Set<string>();
  for (const key of ymap.keys()) {
    existingKeys.add(key);
  }
  for (const [key, value] of Object.entries(obj)) {
    const existing = ymap.get(key);
    if (existing !== value) {
      ymap.set(key, value);
    }
    existingKeys.delete(key);
  }
  for (const key of existingKeys) {
    ymap.delete(key);
  }
}

export class CanvasSync {
  private vault: Vault;
  private syncManager: SyncManager;
  private fileOpsManager: FileOpsManager;
  private subscribedPaths = new Set<string>();
  private observers = new Map<string, () => void>();
  private writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private recentDiskWrites = new Set<string>();
  private recentLocalEdits = new Set<string>();
  private lastWrittenContent = new Map<string, string>();

  constructor(
    vault: Vault,
    syncManager: SyncManager,
    fileOpsManager: FileOpsManager,
  ) {
    this.vault = vault;
    this.syncManager = syncManager;
    this.fileOpsManager = fileOpsManager;
  }

  async subscribe(rawPath: string, role: "host" | "guest"): Promise<void> {
    const path = toCanonicalPath(normalizePath(rawPath));
    if (this.subscribedPaths.has(path)) return;
    this.subscribedPaths.add(path);

    const docId = `${CANVAS_DOC_PREFIX}${path}`;
    const docHandle = this.syncManager.getDoc(docId);
    if (!docHandle) {
      this.subscribedPaths.delete(path);
      return;
    }

    try {
      await this.syncManager.waitForSync(docId);
    } catch {
      this.subscribedPaths.delete(path);
      return;
    }

    if (!this.subscribedPaths.has(path)) return;
    if (this.observers.has(path)) return;

    const nodesMap = docHandle.doc.getMap<Y.Map<unknown>>("nodes");
    const edgesMap = docHandle.doc.getMap<Y.Map<unknown>>("edges");

    const diskPath = toLocalPath(path);
    if (role === "host") {
      const file = getFileByPath(this.vault, diskPath);
      if (file) {
        const content = await this.vault.read(file);
        const data = parseCanvas(content);
        this.recentLocalEdits.add(path);
        docHandle.doc.transact(() => {
          this.applyCanvasToYMaps(nodesMap, edgesMap, data);
        });
        this.recentLocalEdits.delete(path);
      }
    } else {
      if (nodesMap.size > 0 || edgesMap.size > 0) {
        const content = serializeCanvas(nodesMap, edgesMap);
        await this.writeToDisk(path, content);
      }
    }

    const observer = () => {
      if (this.recentLocalEdits.has(path)) return;
      this.scheduleDiskWrite(path, nodesMap, edgesMap);
    };
    nodesMap.observeDeep(observer);
    edgesMap.observeDeep(observer);
    this.observers.set(path, () => {
      nodesMap.unobserveDeep(observer);
      edgesMap.unobserveDeep(observer);
    });
  }

  unsubscribe(rawPath: string): void {
    const path = toCanonicalPath(normalizePath(rawPath));
    this.subscribedPaths.delete(path);
    const timer = this.writeTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      this.writeTimers.delete(path);
    }
    const unobserve = this.observers.get(path);
    if (unobserve) {
      unobserve();
      this.observers.delete(path);
    }
    this.syncManager.releaseDoc(`${CANVAS_DOC_PREFIX}${path}`);
  }

  async handleLocalModify(rawPath: string): Promise<void> {
    const path = toCanonicalPath(normalizePath(rawPath));
    if (this.recentDiskWrites.has(path)) return;
    if (!this.subscribedPaths.has(path)) return;

    const docId = `${CANVAS_DOC_PREFIX}${path}`;
    const docHandle = this.syncManager.getDoc(docId);
    if (!docHandle) return;

    const file = getFileByPath(this.vault, toLocalPath(path));
    if (!file) return;

    const content = await this.vault.read(file);
    const data = parseCanvas(content);
    const nodesMap = docHandle.doc.getMap<Y.Map<unknown>>("nodes");
    const edgesMap = docHandle.doc.getMap<Y.Map<unknown>>("edges");

    this.recentLocalEdits.add(path);
    docHandle.doc.transact(() => {
      this.applyCanvasToYMaps(nodesMap, edgesMap, data);
    });
    this.recentLocalEdits.delete(path);
  }

  isRecentDiskWrite(rawPath: string): boolean {
    return this.recentDiskWrites.has(toCanonicalPath(normalizePath(rawPath)));
  }

  isSubscribed(rawPath: string): boolean {
    return this.subscribedPaths.has(toCanonicalPath(normalizePath(rawPath)));
  }

  destroy(): void {
    for (const timer of this.writeTimers.values()) {
      clearTimeout(timer);
    }
    this.writeTimers.clear();
    for (const [, unobserve] of this.observers) {
      unobserve();
    }
    this.observers.clear();
    for (const path of [...this.subscribedPaths]) {
      this.syncManager.releaseDoc(`${CANVAS_DOC_PREFIX}${path}`);
    }
    this.subscribedPaths.clear();
    this.recentDiskWrites.clear();
    this.recentLocalEdits.clear();
    this.lastWrittenContent.clear();
  }

  private applyCanvasToYMaps(
    nodesMap: Y.Map<Y.Map<unknown>>,
    edgesMap: Y.Map<Y.Map<unknown>>,
    data: CanvasData,
  ): void {
    const existingNodeIds = new Set(nodesMap.keys());
    for (const [id, node] of Object.entries(data.nodes)) {
      let yNode = nodesMap.get(id);
      if (!yNode) {
        yNode = new Y.Map<unknown>();
        nodesMap.set(id, yNode);
      }
      applyToYMap(yNode, node);
      existingNodeIds.delete(id);
    }
    for (const id of existingNodeIds) {
      nodesMap.delete(id);
    }

    const existingEdgeIds = new Set(edgesMap.keys());
    for (const [id, edge] of Object.entries(data.edges)) {
      let yEdge = edgesMap.get(id);
      if (!yEdge) {
        yEdge = new Y.Map<unknown>();
        edgesMap.set(id, yEdge);
      }
      applyToYMap(yEdge, edge);
      existingEdgeIds.delete(id);
    }
    for (const id of existingEdgeIds) {
      edgesMap.delete(id);
    }
  }

  private scheduleDiskWrite(
    path: string,
    nodesMap: Y.Map<Y.Map<unknown>>,
    edgesMap: Y.Map<Y.Map<unknown>>,
  ): void {
    const existing = this.writeTimers.get(path);
    if (existing) clearTimeout(existing);
    this.writeTimers.set(
      path,
      setTimeout(() => {
        this.writeTimers.delete(path);
        const content = serializeCanvas(nodesMap, edgesMap);
        void this.writeToDisk(path, content);
      }, DEBOUNCE_MS),
    );
  }

  private async writeToDisk(path: string, content: string): Promise<void> {
    if (this.lastWrittenContent.get(path) === content) return;
    const diskPath = toLocalPath(path);
    this.recentDiskWrites.add(path);
    this.fileOpsManager.mutePathEvents(diskPath);
    try {
      const parentDir = diskPath.substring(0, diskPath.lastIndexOf("/"));
      if (parentDir) await ensureFolder(this.vault, parentDir);
      await this.vault.adapter.write(diskPath, content);
      this.lastWrittenContent.set(path, content);
    } catch {
      new Notice(`Live Share: failed to write canvas ${diskPath}`);
    } finally {
      setTimeout(() => {
        this.recentDiskWrites.delete(path);
        this.fileOpsManager.unmutePathEvents(diskPath);
      }, VAULT_EVENT_SETTLE_MS);
    }
  }
}
