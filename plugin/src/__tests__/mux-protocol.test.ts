import { describe, expect, it } from "vitest";
import {
  MUX_AWARENESS,
  MUX_SUBSCRIBE,
  MUX_SUBSCRIBED,
  MUX_SYNC,
  MUX_SYNC_REQUEST,
  MUX_UNSUBSCRIBE,
  decodeMuxMessage,
  encodeMuxMessage,
} from "../sync/mux-protocol";

describe("mux-protocol constants", () => {
  it("has distinct message type values", () => {
    const types = [
      MUX_SYNC,
      MUX_AWARENESS,
      MUX_SUBSCRIBE,
      MUX_UNSUBSCRIBE,
      MUX_SUBSCRIBED,
      MUX_SYNC_REQUEST,
    ];
    expect(new Set(types).size).toBe(types.length);
  });
});

describe("encodeMuxMessage / decodeMuxMessage", () => {
  it("round-trips a subscribe message without payload", () => {
    const encoded = encodeMuxMessage("doc-1", MUX_SUBSCRIBE);
    const decoded = decodeMuxMessage(encoded);
    expect(decoded.docId).toBe("doc-1");
    expect(decoded.msgType).toBe(MUX_SUBSCRIBE);
    expect(decoded.payload.byteLength).toBe(0);
  });

  it("round-trips a sync message with payload", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const encoded = encodeMuxMessage("notes/readme.md", MUX_SYNC, payload);
    const decoded = decodeMuxMessage(encoded);
    expect(decoded.docId).toBe("notes/readme.md");
    expect(decoded.msgType).toBe(MUX_SYNC);
    expect(decoded.payload).toEqual(payload);
  });

  it("round-trips an awareness message", () => {
    const payload = new Uint8Array([10, 20, 30]);
    const encoded = encodeMuxMessage("doc-2", MUX_AWARENESS, payload);
    const decoded = decodeMuxMessage(encoded);
    expect(decoded.docId).toBe("doc-2");
    expect(decoded.msgType).toBe(MUX_AWARENESS);
    expect(decoded.payload).toEqual(payload);
  });

  it("round-trips an unsubscribe message", () => {
    const encoded = encodeMuxMessage("my-doc", MUX_UNSUBSCRIBE);
    const decoded = decodeMuxMessage(encoded);
    expect(decoded.docId).toBe("my-doc");
    expect(decoded.msgType).toBe(MUX_UNSUBSCRIBE);
  });

  it("round-trips a subscribed message", () => {
    const payload = new Uint8Array([0]);
    const encoded = encodeMuxMessage("doc-x", MUX_SUBSCRIBED, payload);
    const decoded = decodeMuxMessage(encoded);
    expect(decoded.docId).toBe("doc-x");
    expect(decoded.msgType).toBe(MUX_SUBSCRIBED);
    expect(decoded.payload).toEqual(payload);
  });

  it("round-trips a sync-request message", () => {
    const encoded = encodeMuxMessage("doc-y", MUX_SYNC_REQUEST);
    const decoded = decodeMuxMessage(encoded);
    expect(decoded.docId).toBe("doc-y");
    expect(decoded.msgType).toBe(MUX_SYNC_REQUEST);
  });

  it("handles empty payload explicitly passed", () => {
    const encoded = encodeMuxMessage("doc-z", MUX_SYNC, new Uint8Array(0));
    const decoded = decodeMuxMessage(encoded);
    expect(decoded.docId).toBe("doc-z");
    expect(decoded.msgType).toBe(MUX_SYNC);
    expect(decoded.payload.byteLength).toBe(0);
  });

  it("handles docId with special characters", () => {
    const docId = "folder/sub folder/file (1).md";
    const encoded = encodeMuxMessage(docId, MUX_SUBSCRIBE);
    const decoded = decodeMuxMessage(encoded);
    expect(decoded.docId).toBe(docId);
  });

  it("handles large payload", () => {
    const payload = new Uint8Array(10000);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
    const encoded = encodeMuxMessage("big-doc", MUX_SYNC, payload);
    const decoded = decodeMuxMessage(encoded);
    expect(decoded.payload).toEqual(payload);
  });
});
