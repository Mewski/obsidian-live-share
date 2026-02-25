/** CodeMirror 6 Yjs integration for real-time collaborative editing. */

import { Compartment, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Notice } from "obsidian";
import { yCollab } from "y-codemirror.next";

import { type SyncManager, waitForSync } from "./sync";
import type { SessionRole } from "./types";

export class CollabManager {
  private compartment = new Compartment();
  private currentPath: string | null = null;

  getBaseExtension(): Extension {
    return this.compartment.of([]);
  }

  async activateForFile(
    view: EditorView,
    filePath: string | null,
    syncManager: SyncManager,
    role?: SessionRole,
    permission?: "read-write" | "read-only",
  ) {
    this.currentPath = filePath;
    if (!filePath) {
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }
    const result = syncManager.getDoc(filePath);
    if (!result) {
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }

    try {
      await waitForSync(result.provider);
    } catch {
      new Notice("Live Share: sync timed out");
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }

    // If the file switched while we were waiting, bail
    if (this.currentPath !== filePath) return;

    // Only the host seeds content to prevent duplication race
    if (role === "host") {
      const localContent = view.state.doc.toString();
      if (result.text.length === 0 && localContent.length > 0) {
        result.doc.transact(() => {
          result.text.insert(0, localContent);
        });
      }
    }

    const extensions: Extension[] = [yCollab(result.text, result.provider.awareness)];
    if (permission === "read-only") {
      extensions.push(EditorState.readOnly.of(true));
    }
    view.dispatch({
      effects: this.compartment.reconfigure(extensions),
    });
  }

  deactivateAll(view: EditorView) {
    this.currentPath = null;
    view.dispatch({ effects: this.compartment.reconfigure([]) });
  }
}
