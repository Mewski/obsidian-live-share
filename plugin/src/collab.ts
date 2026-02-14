import { Compartment } from "@codemirror/state";
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

    view.dispatch({
      effects: this.compartment.reconfigure(yCollab(result.text, result.provider.awareness)),
    });
  }

  deactivateAll(view: EditorView) {
    this.currentPath = null;
    view.dispatch({ effects: this.compartment.reconfigure([]) });
  }

  getCurrentPath(): string | null {
    return this.currentPath;
  }
}
