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
    const previousAwareness = this.currentAwareness;
    const previousView = this.currentView;

    const clearPrevious = () => {
      previousAwareness?.setLocalState(null);
      if (previousView && previousView !== view) {
        try {
          previousView.dispatch({ effects: this.compartment.reconfigure([]) });
        } catch {
          // The previous view may already be destroyed.
        }
      }
    };

    const clearCurrentTransition = () => {
      clearPrevious();
      this.currentPath = null;
      this.currentView = null;
      this.currentAwareness = null;
    };

    if (!filePath) {
      clearCurrentTransition();
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }

    const docHandle = syncManager.getDoc(filePath);
    if (!docHandle) {
      clearCurrentTransition();
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }

    try {
      await syncManager.waitForSync(filePath);
    } catch {
      if (this.activationGen !== gen) return;
      new Notice("Live Share: sync timed out");
      clearCurrentTransition();
      try {
        view.dispatch({ effects: this.compartment.reconfigure([]) });
      } catch {
        // The new view may have been destroyed during synchronization.
      }
      return;
    }

    if (this.activationGen !== gen) return;
    // CodeMirror exposes this lifecycle flag at runtime but keeps it private in the type declaration.
    const lifecycleView = view as unknown as { readonly destroyed?: boolean };
    if (lifecycleView.destroyed === true) {
      clearCurrentTransition();
      return;
    }

    if (role === "host") {
      const localContent = normalizeLineEndings(view.state.doc.toString());
      docHandle.doc.transact(() => {
        applyMinimalYTextUpdate(docHandle.doc, docHandle.text, localContent);
        docHandle.doc.getMap("meta").set("seeded", true);
      });
    }

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

    try {
      view.dispatch({
        effects: this.compartment.reconfigure(extensions),
      });
    } catch (error) {
      if (docHandle.awareness !== previousAwareness) {
        docHandle.awareness.setLocalState(null);
      }
      if (this.activationGen === gen) clearCurrentTransition();
      throw error;
    }

    this.currentPath = filePath;
    this.currentView = view;
    this.currentAwareness = docHandle.awareness;

    const selection = view.state.selection.main;
    const anchor = Y.createRelativePositionFromTypeIndex(docHandle.text, selection.anchor);
    const head = Y.createRelativePositionFromTypeIndex(docHandle.text, selection.head);
    docHandle.awareness.setLocalStateField("cursor", { anchor, head });

    if (previousAwareness && previousAwareness !== docHandle.awareness) {
      previousAwareness.setLocalState(null);
    }
    if (previousView && previousView !== view) {
      try {
        previousView.dispatch({ effects: this.compartment.reconfigure([]) });
      } catch {
        // The previous view may already be destroyed.
      }
    }
  }

  updateCursorUser(user: CursorUser): void {
    this.currentAwareness?.setLocalStateField("user", user);
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
