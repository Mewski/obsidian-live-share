import { Compartment, EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Notice } from "obsidian";
import { yCollab } from "y-codemirror.next";
import type * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";

import type { SyncManager } from "../sync/sync";
import type { Permission, SessionRole } from "../types";
import { applyMinimalYTextUpdate, normalizeLineEndings } from "../utils";
import { conflictExtension } from "./conflict-decoration";

export interface CursorUser {
  name: string;
  color: string;
  colorLight: string;
}

export class CollabManager {
  private compartment = new Compartment();
  private currentPath: string | null = null;
  private currentView: EditorView | null = null;
  private currentAwareness: awarenessProtocol.Awareness | null = null;
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

    if (filePath !== this.currentPath || view !== this.currentView) {
      if (this.currentAwareness) {
        this.currentAwareness.setLocalState(null);
      }
      if (this.currentView && this.currentView !== view) {
        try {
          this.currentView.dispatch({
            effects: this.compartment.reconfigure([]),
          });
        } catch {
          // Previous view may have been destroyed
        }
      }
      this.currentAwareness = null;
    }
    this.currentPath = filePath;
    this.currentView = view;
    if (!filePath) {
      this.currentAwareness = null;
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }
    const docHandle = syncManager.getDoc(filePath);
    if (!docHandle) {
      this.currentAwareness = null;
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }

    try {
      await syncManager.waitForSync(filePath);
    } catch {
      if (this.activationGen !== gen) return;
      new Notice("Live share: sync timed out");
      this.currentAwareness = null;
      try {
        view.dispatch({ effects: this.compartment.reconfigure([]) });
      } catch {
        // View may have been destroyed during sync
      }
      return;
    }

    if (this.activationGen !== gen) return;
    // biome-ignore lint/suspicious/noExplicitAny: CM6 marks `destroyed` private
    if ((view as any).destroyed) return;

    if (role !== "host" && docHandle.text.length === 0) {
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (this.activationGen !== gen) return;
        // biome-ignore lint/suspicious/noExplicitAny: CM6 marks `destroyed` private
        if ((view as any).destroyed) return;
        if (docHandle.text.length > 0) break;
      }
    }

    if (role === "host") {
      const localContent = normalizeLineEndings(view.state.doc.toString());
      applyMinimalYTextUpdate(docHandle.doc, docHandle.text, localContent);
    }

    this.currentAwareness = docHandle.awareness;
    if (cursorUser) {
      docHandle.awareness.setLocalStateField("user", cursorUser);
    }
    const collabExt = yCollab(docHandle.text, docHandle.awareness, {
      undoManager: false,
    });
    const extensions: Extension[] = Array.isArray(collabExt) ? [...collabExt] : [collabExt];
    extensions.push(conflictExtension());
    if (permission === "read-only") {
      extensions.push(EditorState.readOnly.of(true));
    }
    view.dispatch({
      effects: this.compartment.reconfigure(extensions),
    });

    const selection = view.state.selection.main;
    const anchor = Y.createRelativePositionFromTypeIndex(docHandle.text, selection.anchor);
    const head = Y.createRelativePositionFromTypeIndex(docHandle.text, selection.head);
    docHandle.awareness.setLocalStateField("cursor", { anchor, head });
  }

  deactivateAll(view: EditorView) {
    this.activationGen++;
    if (this.currentAwareness) {
      this.currentAwareness.setLocalState(null);
      this.currentAwareness = null;
    }
    this.currentPath = null;
    this.currentView = null;
    view.dispatch({ effects: this.compartment.reconfigure([]) });
  }
}
