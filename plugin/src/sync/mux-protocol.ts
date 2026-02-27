import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

export const MUX_SYNC = 0;
export const MUX_AWARENESS = 1;
export const MUX_SUBSCRIBE = 2;
export const MUX_UNSUBSCRIBE = 3;
export const MUX_SUBSCRIBED = 4;
export const MUX_SYNC_REQUEST = 6;
export const MUX_SYNC_ENCRYPTED = 7;
export const MUX_AWARENESS_ENCRYPTED = 8;

export function encodeMuxMessage(docId: string, msgType: number, payload?: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, docId);
  encoding.writeVarUint(encoder, msgType);
  if (payload) encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

export function decodeMuxMessage(data: Uint8Array): {
  docId: string;
  msgType: number;
  payload: Uint8Array;
} {
  const decoder = decoding.createDecoder(data);
  const docId = decoding.readVarString(decoder);
  const msgType = decoding.readVarUint(decoder);
  const payload = decoding.hasContent(decoder)
    ? decoding.readVarUint8Array(decoder)
    : new Uint8Array(0);
  return { docId, msgType, payload };
}
