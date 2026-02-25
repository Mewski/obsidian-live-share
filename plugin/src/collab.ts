import { Compartment, EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Notice } from "obsidian";
import { yCollab } from "y-codemirror.next";

import { type SyncManager, waitForSync } from "./sync";
import type { Permission, SessionRole } from "./types";

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
    permission?: Permission,
  ) {
    this.currentPath = filePath;
    if (!filePath) {
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }
    const docHandle = syncManager.getDoc(filePath);
    if (!docHandle) {
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }

    try {
      await waitForSync(docHandle.provider);
    } catch {
      new Notice("Live Share: sync timed out");
      view.dispatch({ effects: this.compartment.reconfigure([]) });
      return;
    }

    if (this.currentPath !== filePath) return;

    if (role === "host") {
      const localContent = view.state.doc.toString();
      const remoteContent = docHandle.text.toString();
      if (localContent !== remoteContent) {
        docHandle.doc.transact(() => {
          docHandle.text.delete(0, docHandle.text.length);
          docHandle.text.insert(0, localContent);
        });
      }
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
    this.currentPath = null;
    view.dispatch({ effects: this.compartment.reconfigure([]) });
  }
}
