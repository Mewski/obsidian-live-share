import { MarkdownView, Notice, TFile } from "obsidian";
import type LiveSharePlugin from "../main";
import type { FocusRequestMessage, SummonMessage } from "../types";
import { toLocalPath } from "../utils";

export function showFocusNotification(
  plugin: LiveSharePlugin,
  request: FocusRequestMessage | SummonMessage,
) {
  const fragment = document.createDocumentFragment();
  fragment.createEl("span", {
    text: `Live Share: ${request.fromDisplayName} wants your attention at ${request.filePath}:${request.line + 1}`,
  });
  fragment.createEl("br");
  const goToButton = fragment.createEl("button", {
    text: "Go to",
    cls: "live-share-focus-goto",
  });
  goToButton.addEventListener("click", async () => {
    const file = plugin.app.vault.getAbstractFileByPath(toLocalPath(request.filePath));
    if (file instanceof TFile) {
      const leaf = plugin.app.workspace.getLeaf();
      await leaf.openFile(file);
      const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) {
        view.editor.setCursor({ line: request.line, ch: request.ch });
        view.editor.scrollIntoView(
          {
            from: { line: request.line, ch: 0 },
            to: { line: request.line, ch: 0 },
          },
          true,
        );
      }
    }
  });

  new Notice(fragment, 10000);
}
