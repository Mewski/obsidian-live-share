// Minimal obsidian mock for tests
export class Notice {}

export class Modal {
  app: any;
  contentEl = { createEl: () => ({}), createDiv: () => ({}), empty: () => {} };
  constructor(app: any) {
    this.app = app;
  }
  open() {}
  close() {}
  onOpen() {}
  onClose() {}
}

export class Plugin {
  app: any = {};
  manifest: any = {};
  loadData() {
    return Promise.resolve({});
  }
  saveData(_data: any) {
    return Promise.resolve();
  }
  addCommand(_cmd: any) {}
  addSettingTab(_tab: any) {}
  addStatusBarItem() {
    return { setText: () => {}, addEventListener: () => {}, style: {} };
  }
  addRibbonIcon() {
    return {} as any;
  }
  registerView() {}
  registerEvent() {}
  registerEditorExtension() {}
}

export class PluginSettingTab {
  app: any;
  containerEl = { empty: () => {} };
  constructor(app: any, _plugin: any) {
    this.app = app;
  }
  display() {}
}

export class ItemView {
  leaf: any;
  contentEl = { empty: () => {}, createEl: () => ({}), createDiv: () => ({}) };
  constructor(leaf: any) {
    this.leaf = leaf;
  }
  getViewType() {
    return "";
  }
  getDisplayText() {
    return "";
  }
  getIcon() {
    return "";
  }
  onOpen() {
    return Promise.resolve();
  }
  onClose() {
    return Promise.resolve();
  }
}

export class MarkdownView {}
export class TFile {
  path = "";
  stat = { size: 0, mtime: 0, ctime: 0 };
}
export class TFolder {}
export class TAbstractFile {
  path = "";
}

export class Setting {
  setName(_n: string) {
    return this;
  }
  setDesc(_d: string) {
    return this;
  }
  addText(_cb: any) {
    return this;
  }
  addButton(_cb: any) {
    return this;
  }
}
