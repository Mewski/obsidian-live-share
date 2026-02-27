import { type App, Modal, Setting, TextAreaComponent } from "obsidian";

import type { Comment, CommentManager } from "../files/comments";

export class AddCommentModal extends Modal {
  private onSubmit: (text: string) => void;

  constructor(app: App, onSubmit: (text: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Add comment" });

    let text = "";
    new Setting(contentEl).setName("Comment").addTextArea((ta) => {
      ta.setPlaceholder("Write a comment...");
      ta.onChange((value) => {
        text = value;
      });
      ta.inputEl.rows = 4;
      ta.inputEl.style.width = "100%";
    });

    new Setting(contentEl).addButton((btn) => {
      btn
        .setButtonText("Add")
        .setCta()
        .onClick(() => {
          if (text.trim()) {
            this.onSubmit(text.trim());
            this.close();
          }
        });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export class CommentThreadModal extends Modal {
  private filePath: string;
  private comment: Comment;
  private commentManager: CommentManager;
  private unobserve: (() => void) | null = null;

  constructor(app: App, filePath: string, comment: Comment, commentManager: CommentManager) {
    super(app);
    this.filePath = filePath;
    this.comment = comment;
    this.commentManager = commentManager;
  }

  onOpen() {
    this.render();
    this.unobserve = this.commentManager.onCommentsChange(this.filePath, () => {
      const comments = this.commentManager.getComments(this.filePath);
      const updated = comments.find((c) => c.id === this.comment.id);
      if (updated) {
        this.comment = updated;
        this.render();
      }
    });
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("live-share-comment-thread");

    const header = contentEl.createEl("div", {
      cls: "live-share-comment-header",
    });
    header.createEl("strong", { text: this.comment.author });
    header.createEl("span", {
      text: ` at line ${this.comment.anchorIndex + 1}`,
      cls: "live-share-comment-meta",
    });
    if (this.comment.resolved) {
      header.createEl("span", {
        text: " (resolved)",
        cls: "live-share-comment-resolved",
      });
    }

    contentEl.createEl("p", {
      text: this.comment.text,
      cls: "live-share-comment-body",
    });

    contentEl.createEl("small", {
      text: new Date(this.comment.timestamp).toLocaleString(),
      cls: "live-share-comment-time",
    });

    if (this.comment.replies.length > 0) {
      const repliesEl = contentEl.createEl("div", {
        cls: "live-share-comment-replies",
      });
      for (const reply of this.comment.replies) {
        const replyEl = repliesEl.createEl("div", {
          cls: "live-share-comment-reply",
        });
        replyEl.createEl("strong", { text: reply.author });
        replyEl.createEl("span", {
          text: `: ${reply.text}`,
        });
        replyEl.createEl("br");
        replyEl.createEl("small", {
          text: new Date(reply.timestamp).toLocaleString(),
          cls: "live-share-comment-time",
        });
      }
    }

    const actions = new Setting(contentEl);
    actions.addButton((btn) => {
      btn.setButtonText(this.comment.resolved ? "Unresolve" : "Resolve").onClick(() => {
        this.commentManager.resolveComment(this.filePath, this.comment.id);
      });
    });
    actions.addButton((btn) => {
      btn
        .setButtonText("Delete")
        .setWarning()
        .onClick(() => {
          this.commentManager.deleteComment(this.filePath, this.comment.id);
          this.close();
        });
    });

    let replyText = "";
    new Setting(contentEl).setName("Reply").addTextArea((ta) => {
      ta.setPlaceholder("Write a reply...");
      ta.onChange((value) => {
        replyText = value;
      });
      ta.inputEl.rows = 2;
      ta.inputEl.style.width = "100%";
    });
    new Setting(contentEl).addButton((btn) => {
      btn
        .setButtonText("Reply")
        .setCta()
        .onClick(() => {
          if (replyText.trim()) {
            this.commentManager.addReply(this.filePath, this.comment.id, replyText.trim());
          }
        });
    });
  }

  onClose() {
    this.unobserve?.();
    this.contentEl.empty();
  }
}

export class CommentListModal extends Modal {
  private filePath: string;
  private commentManager: CommentManager;
  private onNavigate: (line: number) => void;
  private unobserve: (() => void) | null = null;

  constructor(
    app: App,
    filePath: string,
    commentManager: CommentManager,
    onNavigate: (line: number) => void,
  ) {
    super(app);
    this.filePath = filePath;
    this.commentManager = commentManager;
    this.onNavigate = onNavigate;
  }

  onOpen() {
    this.render();
    this.unobserve = this.commentManager.onCommentsChange(this.filePath, () => this.render());
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: `Comments: ${this.filePath}` });

    const comments = this.commentManager.getComments(this.filePath);

    if (comments.length === 0) {
      contentEl.createEl("p", { text: "No comments on this file." });
      return;
    }

    const list = contentEl.createEl("div", {
      cls: "live-share-comment-list",
    });

    for (const comment of comments) {
      const item = list.createEl("div", {
        cls: `live-share-comment-item${comment.resolved ? " is-resolved" : ""}`,
      });

      const header = item.createEl("div", {
        cls: "live-share-comment-item-header",
      });
      header.createEl("strong", { text: comment.author });
      header.createEl("span", {
        text: ` - Line ${comment.anchorIndex + 1}`,
        cls: "live-share-comment-meta",
      });
      if (comment.resolved) {
        header.createEl("span", {
          text: " (resolved)",
          cls: "live-share-comment-resolved",
        });
      }
      if (comment.replies.length > 0) {
        header.createEl("span", {
          text: ` (${comment.replies.length} ${comment.replies.length === 1 ? "reply" : "replies"})`,
          cls: "live-share-comment-meta",
        });
      }

      item.createEl("p", {
        text: comment.text,
        cls: "live-share-comment-body",
      });

      const actions = item.createEl("div", {
        cls: "live-share-comment-item-actions",
      });

      const goBtn = actions.createEl("button", { text: "Go to line" });
      goBtn.addEventListener("click", () => {
        this.onNavigate(comment.anchorIndex);
        this.close();
      });

      const viewBtn = actions.createEl("button", { text: "View thread" });
      viewBtn.addEventListener("click", () => {
        new CommentThreadModal(this.app, this.filePath, comment, this.commentManager).open();
      });
    }
  }

  onClose() {
    this.unobserve?.();
    this.contentEl.empty();
  }
}
