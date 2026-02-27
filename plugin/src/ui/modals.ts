import { type App, FuzzySuggestModal, Modal } from "obsidian";

export class PromptModal extends Modal {
  private result: string | null = null;
  private placeholder: string;
  private resolve: (value: string | null) => void;

  constructor(app: App, placeholder: string, resolve: (value: string | null) => void) {
    super(app);
    this.setTitle("Live share");
    this.placeholder = placeholder;
    this.resolve = resolve;
  }

  override onOpen() {
    const { contentEl } = this;
    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: this.placeholder,
      cls: "live-share-prompt-input",
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        this.result = input.value;
        this.close();
      }
    });
    const submitButton = contentEl.createEl("button", { text: "OK" });
    submitButton.addEventListener("click", () => {
      this.result = input.value;
      this.close();
    });
    input.focus();
  }

  closeWithValue(value: string | null) {
    this.result = value;
    this.close();
  }

  override onClose() {
    this.resolve(this.result || null);
    this.contentEl.empty();
  }
}

export class UserPickerModal extends FuzzySuggestModal<string> {
  private users: Map<string, { displayName: string }>;
  private onChoose: (userId: string) => void;

  constructor(
    app: App,
    users: Map<string, { displayName: string }>,
    onChoose: (userId: string) => void,
  ) {
    super(app);
    this.users = users;
    this.onChoose = onChoose;
  }

  getItems(): string[] {
    return Array.from(this.users.keys());
  }

  getItemText(userId: string): string {
    return this.users.get(userId)?.displayName ?? userId;
  }

  onChooseItem(userId: string): void {
    this.onChoose(userId);
  }
}

export class ConfirmModal extends Modal {
  private message: string;
  private resolve: (value: boolean) => void;
  private hasDecided = false;

  constructor(app: App, message: string, resolve: (value: boolean) => void) {
    super(app);
    this.setTitle("Live share");
    this.message = message;
    this.resolve = resolve;
  }

  override onOpen() {
    const { contentEl } = this;
    contentEl.createEl("p", { text: this.message });
    const buttons = contentEl.createDiv({ cls: "live-share-confirm-buttons" });
    const confirm = buttons.createEl("button", {
      text: "Confirm",
      cls: "mod-warning",
    });
    confirm.addEventListener("click", () => {
      this.hasDecided = true;
      this.resolve(true);
      this.close();
    });
    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => {
      this.hasDecided = true;
      this.resolve(false);
      this.close();
    });
  }

  override onClose() {
    if (!this.hasDecided) this.resolve(false);
    this.contentEl.empty();
  }
}
