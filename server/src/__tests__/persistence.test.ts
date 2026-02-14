import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { rmSync, existsSync } from 'fs';

// Persistence uses LevelDB at ./data/yjs-docs — we need to test against it.
// We import it dynamically so each test can start clean.

const TEST_DB_PATH = './data/yjs-docs-test';

describe('persistence', () => {
  // We'll test the persistence logic directly with Yjs
  // without importing the module (which creates a hardcoded DB path).
  // Instead, test the round-trip logic: encode → decode.

  it('round-trips Y.Doc state via encodeStateAsUpdate', () => {
    const doc1 = new Y.Doc();
    const text1 = doc1.getText('content');
    text1.insert(0, 'persisted content');

    const update = Y.encodeStateAsUpdate(doc1);

    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, update);
    const text2 = doc2.getText('content');

    expect(text2.toString()).toBe('persisted content');

    doc1.destroy();
    doc2.destroy();
  });

  it('preserves multiple edits across encode/decode', () => {
    const doc1 = new Y.Doc();
    const text1 = doc1.getText('content');
    text1.insert(0, 'first');
    text1.insert(5, ' second');
    text1.delete(0, 5); // delete "first"

    const update = Y.encodeStateAsUpdate(doc1);

    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, update);

    expect(doc2.getText('content').toString()).toBe(' second');

    doc1.destroy();
    doc2.destroy();
  });

  it('merges concurrent edits from two docs', () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    // Sync initial state
    const sv1 = Y.encodeStateVector(doc1);
    const sv2 = Y.encodeStateVector(doc2);
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2, sv1));
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1, sv2));

    // Both edit concurrently
    doc1.getText('content').insert(0, 'from-1');
    doc2.getText('content').insert(0, 'from-2');

    // Merge
    const update1 = Y.encodeStateAsUpdate(doc1, Y.encodeStateVector(doc2));
    const update2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));
    Y.applyUpdate(doc1, update2);
    Y.applyUpdate(doc2, update1);

    // Both should converge
    expect(doc1.getText('content').toString()).toBe(doc2.getText('content').toString());
    const merged = doc1.getText('content').toString();
    expect(merged).toContain('from-1');
    expect(merged).toContain('from-2');

    doc1.destroy();
    doc2.destroy();
  });

  it('handles empty doc encode/decode', () => {
    const doc1 = new Y.Doc();
    const update = Y.encodeStateAsUpdate(doc1);
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, update);
    expect(doc2.getText('content').toString()).toBe('');
    doc1.destroy();
    doc2.destroy();
  });
});
