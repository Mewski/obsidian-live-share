import { Notice, TFile, MarkdownView } from "obsidian";
import type LiveSharePlugin from "./main";

export interface FocusRequest {
  fromDisplayName: string;
  filePath: string;
  line: number;
  ch: number;
}

export function showFocusNotification(plugin: LiveSharePlugin, req: FocusRequest) {
  const fragment = document.createDocumentFragment();
  fragment.createEl("span", {
    text: `${req.fromDisplayName} wants your attention at ${req.filePath}:${req.line + 1}`,
  });
  fragment.createEl("br");
  const btn = fragment.createEl("button", {
    text: "Go to",
    cls: "live-share-focus-goto",
  });
  btn.addEventListener("click", async () => {
    const file = plugin.app.vault.getAbstractFileByPath(req.filePath);
    if (file instanceof TFile) {
      const leaf = plugin.app.workspace.getLeaf();
      await leaf.openFile(file);
      const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) {
        view.editor.setCursor({ line: req.line, ch: req.ch });
        view.editor.scrollIntoView(
          { from: { line: req.line, ch: 0 }, to: { line: req.line, ch: 0 } },
          true,
        );
      }
    }
  });

  new Notice(fragment, 10000);
}
