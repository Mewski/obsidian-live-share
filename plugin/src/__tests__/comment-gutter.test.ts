import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import type { Comment } from "../files/comments";

vi.mock("@codemirror/state", () => {
  const MockStateEffect = {
    define: () => ({
      of: (val: unknown) => ({ type: "state-effect", value: val }),
      is: () => false,
    }),
  };
  const MockStateField = {
    define: (config: Record<string, unknown>) => ({
      _create: config.create,
      _update: config.update,
      _provide: config.provide,
    }),
  };
  const MockRangeSet = {
    empty: [],
    of: (ranges: unknown[]) => ranges,
  };
  return {
    StateEffect: MockStateEffect,
    StateField: MockStateField,
    RangeSet: MockRangeSet,
  };
});

vi.mock("@codemirror/view", () => {
  class MockGutterMarker {
    range(from: number) {
      return { from, marker: this };
    }
  }
  return {
    EditorView: {},
    GutterMarker: MockGutterMarker,
    gutter: (config: unknown) => ({ type: "gutter", config }),
  };
});

const { commentGutterExtension, updateCommentPositions } = await import("../editor/comment-gutter");

let nextId = 0;
function createComment(overrides: Partial<Comment> & { anchorIndex: number }): Comment {
  return {
    id: `c${++nextId}`,
    text: "comment",
    author: "User",
    authorId: "u1",
    timestamp: Date.now(),
    resolved: false,
    replies: [],
    ...overrides,
  };
}

function createMockView() {
  return { dispatch: vi.fn() } as unknown as EditorView & {
    dispatch: ReturnType<typeof vi.fn>;
  };
}

describe("commentGutterExtension", () => {
  it("returns an array of extensions", () => {
    const ext = commentGutterExtension(() => {});
    expect(Array.isArray(ext)).toBe(true);
    expect((ext as unknown[]).length).toBe(2);
  });

  it("returns different instances on each call", () => {
    const ext1 = commentGutterExtension(() => {});
    const ext2 = commentGutterExtension(() => {});
    expect(ext1).not.toBe(ext2);
  });
});

describe("updateCommentPositions", () => {
  it("dispatches effect with comment positions grouped by line", () => {
    const view = createMockView();
    const comments = [
      createComment({ anchorIndex: 0, author: "Alice", authorId: "u1" }),
      createComment({ anchorIndex: 2, author: "Bob", authorId: "u2" }),
    ];

    updateCommentPositions(view, comments);

    expect(view.dispatch).toHaveBeenCalledOnce();
    const call = view.dispatch.mock.calls[0][0];
    expect(call.effects).toBeDefined();
    const effectValue = call.effects.value;
    expect(effectValue.byLine.size).toBe(2);
    expect(effectValue.byLine.get(1)).toHaveLength(1);
    expect(effectValue.byLine.get(3)).toHaveLength(1);
  });

  it("groups multiple comments on the same line", () => {
    const view = createMockView();
    const comments = [
      createComment({ anchorIndex: 5, text: "First" }),
      createComment({ anchorIndex: 5, text: "Second" }),
    ];

    updateCommentPositions(view, comments);

    const effectValue = view.dispatch.mock.calls[0][0].effects.value;
    expect(effectValue.byLine.get(6)).toHaveLength(2);
  });

  it("excludes resolved comments", () => {
    const view = createMockView();
    const comments = [
      createComment({ anchorIndex: 0, resolved: false }),
      createComment({ anchorIndex: 1, resolved: true }),
    ];

    updateCommentPositions(view, comments);

    const effectValue = view.dispatch.mock.calls[0][0].effects.value;
    expect(effectValue.byLine.size).toBe(1);
    expect(effectValue.byLine.has(1)).toBe(true);
    expect(effectValue.byLine.has(2)).toBe(false);
  });

  it("produces empty map for no comments", () => {
    const view = createMockView();

    updateCommentPositions(view, []);

    const effectValue = view.dispatch.mock.calls[0][0].effects.value;
    expect(effectValue.byLine.size).toBe(0);
  });
});
