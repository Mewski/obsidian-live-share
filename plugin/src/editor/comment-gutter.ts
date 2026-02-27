import { type Extension, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { type EditorView, GutterMarker, gutter } from "@codemirror/view";

export interface Comment {
  resolved: boolean;
  anchorIndex: number;
}

interface LineComments {
  byLine: Map<number, Comment[]>;
}

const setCommentsEffect = StateEffect.define<LineComments>();

const commentState = StateField.define<LineComments>({
  create() {
    return { byLine: new Map() };
  },
  update(state, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setCommentsEffect)) {
        return effect.value;
      }
    }
    return state;
  },
});

class CommentMarker extends GutterMarker {
  private readonly count: number;
  private readonly onClick: () => void;

  constructor(count: number, onClick: () => void) {
    super();
    this.count = count;
    this.onClick = onClick;
  }

  toDOM(): Node {
    const element = document.createElement("span");
    element.className = "live-share-comment-gutter-icon";
    element.textContent = this.count > 1 ? `${this.count}` : "\u{1F4AC}";
    element.title = `${this.count} comment${this.count > 1 ? "s" : ""}`;
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      this.onClick();
    });
    return element;
  }
}

export function commentGutterExtension(onClickLine: (line: number) => void): Extension {
  const commentGutter = gutter({
    class: "live-share-comment-gutter",
    markers: (view) => {
      const state = view.state.field(commentState, false);
      if (!state || state.byLine.size === 0) return RangeSet.empty;
      const ranges: { from: number; marker: GutterMarker }[] = [];
      for (const [lineNum, comments] of state.byLine) {
        if (lineNum < 1 || lineNum > view.state.doc.lines) continue;
        const line = view.state.doc.line(lineNum);
        ranges.push({
          from: line.from,
          marker: new CommentMarker(comments.length, () => onClickLine(lineNum - 1)),
        });
      }
      ranges.sort((a, b) => a.from - b.from);
      return RangeSet.of(ranges.map((range) => range.marker.range(range.from)));
    },
    initialSpacer: () => new CommentMarker(1, () => {}),
  });

  return [commentState, commentGutter];
}

export function updateCommentPositions(view: EditorView, comments: Comment[]): void {
  const byLine = new Map<number, Comment[]>();
  for (const comment of comments) {
    if (comment.resolved) continue;
    const lineNum = comment.anchorIndex + 1;
    const existing = byLine.get(lineNum) ?? [];
    existing.push(comment);
    byLine.set(lineNum, existing);
  }
  view.dispatch({ effects: setCommentsEffect.of({ byLine }) });
}
