import { type Extension, StateEffect, StateField, Transaction } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

const OVERLAP_WINDOW_MS = 2000;
const DECORATION_LIFETIME_MS = 5000;

interface EditRegion {
  from: number;
  to: number;
  timestamp: number;
}

interface ConflictMark {
  from: number;
  to: number;
  expiry: number;
}

const addConflictEffect = StateEffect.define<ConflictMark>();
const clearExpiredEffect = StateEffect.define<number>();
const setLocalEditsEffect = StateEffect.define<EditRegion[]>();

const conflictMark = Decoration.mark({
  class: "live-share-conflict",
});

const conflictField = StateField.define<{
  localEdits: EditRegion[];
  marks: ConflictMark[];
  decorations: DecorationSet;
}>({
  create() {
    return { localEdits: [], marks: [], decorations: Decoration.none };
  },
  update(state, tr) {
    let { localEdits, marks } = state;
    let changed = false;

    if (tr.docChanged) {
      marks = marks.map((m) => {
        const from = tr.changes.mapPos(m.from, 1);
        const to = tr.changes.mapPos(m.to, -1);
        return { ...m, from: Math.min(from, to), to: Math.max(from, to) };
      });
      localEdits = localEdits.map((e) => {
        const from = tr.changes.mapPos(e.from, 1);
        const to = tr.changes.mapPos(e.to, -1);
        return { ...e, from: Math.min(from, to), to: Math.max(from, to) };
      });
      changed = true;
    }

    for (const effect of tr.effects) {
      if (effect.is(addConflictEffect)) {
        marks = [...marks, effect.value];
        changed = true;
      }
      if (effect.is(clearExpiredEffect)) {
        const now = effect.value;
        const before = marks.length;
        marks = marks.filter((m) => m.expiry > now);
        if (marks.length !== before) changed = true;
      }
      if (effect.is(setLocalEditsEffect)) {
        localEdits = effect.value;
        changed = true;
      }
    }

    if (!changed) return state;

    const decorations = Decoration.set(
      marks
        .filter((m) => m.from < m.to)
        .map((m) => conflictMark.range(m.from, m.to))
        .sort((a, b) => a.from - b.from),
    );
    return { localEdits, marks, decorations };
  },
  provide: (field) => EditorView.decorations.from(field, (s) => s.decorations),
});

function isLocalTransaction(tr: Transaction): boolean {
  const ann = tr.annotation(Transaction.remote);
  return ann !== true;
}

const conflictPlugin = ViewPlugin.fromClass(
  class {
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    constructor(private view: EditorView) {
      this.startCleanup();
    }

    update(update: ViewUpdate) {
      if (!update.docChanged) return;
      const now = Date.now();
      const state = update.view.state.field(conflictField);

      for (const tr of update.transactions) {
        if (!tr.docChanged) continue;

        if (isLocalTransaction(tr)) {
          const newEdits = [...state.localEdits];
          tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
            newEdits.push({ from: fromB, to: toB, timestamp: now });
          });
          const cutoff = now - OVERLAP_WINDOW_MS;
          const filtered = newEdits.filter((e) => e.timestamp > cutoff);
          update.view.dispatch({ effects: setLocalEditsEffect.of(filtered) });
        } else {
          const recentLocal = state.localEdits.filter((e) => now - e.timestamp < OVERLAP_WINDOW_MS);
          if (recentLocal.length === 0) continue;

          const effects: StateEffect<ConflictMark>[] = [];
          tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
            for (const local of recentLocal) {
              if (fromB < local.to && toB > local.from) {
                const overlapFrom = Math.max(fromB, local.from);
                const overlapTo = Math.min(toB, local.to);
                if (overlapFrom < overlapTo) {
                  effects.push(
                    addConflictEffect.of({
                      from: overlapFrom,
                      to: overlapTo,
                      expiry: now + DECORATION_LIFETIME_MS,
                    }),
                  );
                }
              }
            }
          });

          if (effects.length > 0) {
            update.view.dispatch({ effects });
          }
        }
      }
    }

    private startCleanup() {
      this.cleanupTimer = setInterval(() => {
        const state = this.view.state.field(conflictField, false);
        if (!state || state.marks.length === 0) return;
        this.view.dispatch({ effects: clearExpiredEffect.of(Date.now()) });
      }, 1000);
    }

    destroy() {
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
        this.cleanupTimer = null;
      }
    }
  },
);

export function conflictExtension(): Extension {
  return [conflictField, conflictPlugin];
}
