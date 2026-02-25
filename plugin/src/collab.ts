import { Compartment, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Notice } from "obsidian";
import { yCollab } from "y-codemirror.next";

import { type SyncManager, waitForSync } from "./sync";
import type { Permission, SessionRole } from "./types";
import { applyMinimalYTextUpdate, normalizeLineEndings } from "./utils";

export interface CursorUser {
  name: string;
  color: string;
  colorLight: string;
}

export class CollabManager {
  private compartment = new Compartment();
  private currentPath: string | null = null;
  private currentProvider: import("y-websocket").WebsocketProvider | null = null;
  private activationGen = 0;

  getBaseExtension(): Extension {
    return this.compartment.of([]);
  }

  async activateForFile(
    view: EditorView,
    filePath: string | null,
    syncManager: SyncManager,
    role?: SessionRole,
    permission?: Permission,
    cursorUser?: CursorUser,
  ) {
    const gen = ++this.activationGen;

    if (this.currentProvider && filePath !== this.currentPath) {
      this.currentProvider.awareness.setLocalState(null);
      this.currentProvider = null;
    }
    this.currentPath = filePath;
    if (!filePath) {
      if (this.currentProvider) {
        this.currentProvider.awareness.setLocalState(null);
        this.currentProvider = null;
      }
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }
    const docHandle = syncManager.getDoc(filePath);
    if (!docHandle) {
      if (this.currentProvider) {
        this.currentProvider.awareness.setLocalState(null);
        this.currentProvider = null;
      }
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }

    try {
      await waitForSync(docHandle.provider);
    } catch {
      new Notice("Live Share: sync timed out");
      if (this.currentProvider) {
        this.currentProvider.awareness.setLocalState(null);
        this.currentProvider = null;
      }
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }

    if (this.activationGen !== gen) return;

    if (role !== "host" && docHandle.text.length === 0) {
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (this.activationGen !== gen) return;
        if (docHandle.text.length > 0) break;
      }
      if (docHandle.text.length === 0) return;
    }

    if (role === "host") {
      const localContent = normalizeLineEndings(view.state.doc.toString());
      applyMinimalYTextUpdate(docHandle.doc, docHandle.text, localContent);
    }

    this.currentProvider = docHandle.provider;
    if (cursorUser) {
      docHandle.provider.awareness.setLocalStateField("user", cursorUser);
    }
    const extensions: Extension[] = [yCollab(docHandle.text, docHandle.provider.awareness)];
    if (permission === "read-only") {
      extensions.push(EditorState.readOnly.of(true));
    }
    view.dispatch({
      effects: this.compartment.reconfigure(extensions),
    });
  }

  deactivateAll(view: EditorView) {
    this.activationGen++;
    if (this.currentProvider) {
      this.currentProvider.awareness.setLocalState(null);
      this.currentProvider = null;
    }
    this.currentPath = null;
    view.dispatch({ effects: this.compartment.reconfigure([]) });
  }
}
