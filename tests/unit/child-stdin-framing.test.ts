// src/lib/connectors/child-stdin-framing.ts — the length-prefixed binary
// frame that keeps the data key (DK) a raw Buffer end to end across the
// parent -> scrape-worker.mts stdin boundary (docs plan §C). Pure functions,
// tested without spawning a real child process.
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decodeChildStdinFrame,
  encodeChildStdinFrame,
  type ChildStdinPayload,
} from "@/lib/connectors/child-stdin-framing";

const payload: ChildStdinPayload = {
  syncRunId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  connectionId: "33333333-3333-3333-3333-333333333333",
  connectorId: "leumi",
  startDate: "2026-01-01",
  credentials: { username: "dana", password: "hunter2" },
};

describe("child-stdin-framing", () => {
  it("round-trips the data key as a genuine Buffer, byte for byte", () => {
    const dataKey = randomBytes(32);
    const frame = encodeChildStdinFrame(dataKey, payload);
    const decoded = decodeChildStdinFrame(frame);

    expect(Buffer.isBuffer(decoded.dataKey)).toBe(true);
    expect(decoded.dataKey.equals(dataKey)).toBe(true);
  });

  it("round-trips the JSON payload exactly", () => {
    const dataKey = randomBytes(32);
    const frame = encodeChildStdinFrame(dataKey, payload);
    const decoded = decodeChildStdinFrame(frame);
    expect(decoded.payload).toEqual(payload);
  });

  it("round-trips a data key of a different length", () => {
    const dataKey = randomBytes(16);
    const frame = encodeChildStdinFrame(dataKey, payload);
    const decoded = decodeChildStdinFrame(frame);
    expect(decoded.dataKey.equals(dataKey)).toBe(true);
  });

  it("the encoded frame never contains a base64/JSON-encoded copy of the key", () => {
    const dataKey = randomBytes(32);
    const frame = encodeChildStdinFrame(dataKey, payload);
    const base64Key = dataKey.toString("base64");
    // The frame holds the key as raw bytes, not as a base64 string embedded
    // in the JSON tail — searching the JSON portion for the base64 form
    // should never find it.
    const jsonStart = frame.indexOf(Buffer.from("{"));
    const jsonTail = frame.subarray(jsonStart).toString("utf8");
    expect(jsonTail.includes(base64Key)).toBe(false);
  });

  it("throws on a frame truncated inside the data-key length prefix", () => {
    const dataKey = randomBytes(32);
    const frame = encodeChildStdinFrame(dataKey, payload);
    expect(() => decodeChildStdinFrame(frame.subarray(0, 2))).toThrow();
  });

  it("throws on a frame truncated inside the data-key bytes", () => {
    const dataKey = randomBytes(32);
    const frame = encodeChildStdinFrame(dataKey, payload);
    expect(() => decodeChildStdinFrame(frame.subarray(0, 10))).toThrow();
  });

  it("throws on a frame truncated inside the JSON length prefix", () => {
    const dataKey = randomBytes(32);
    const frame = encodeChildStdinFrame(dataKey, payload);
    expect(() => decodeChildStdinFrame(frame.subarray(0, 4 + dataKey.length + 2))).toThrow();
  });

  it("throws on a frame truncated inside the JSON bytes", () => {
    const dataKey = randomBytes(32);
    const frame = encodeChildStdinFrame(dataKey, payload);
    expect(() => decodeChildStdinFrame(frame.subarray(0, 4 + dataKey.length + 4 + 3))).toThrow();
  });
});
