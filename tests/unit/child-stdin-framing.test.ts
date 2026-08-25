// src/lib/connectors/child-stdin-framing.ts — the length-prefixed binary frame
// that carries a worker's raw secret SEGMENTS (e.g. [CK, credentials_ct] for
// the bank fetcher, [DK, accounts] for the promoter) while confining JSON to
// non-secret structural metadata. Pure functions, tested without spawning a
// child.
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decodeBinaryChildFrame,
  encodeBinaryChildFrame,
} from "@/lib/connectors/child-stdin-framing";

const META = {
  connectionId: "33333333-3333-3333-3333-333333333333",
  connectorId: "leumi",
  startDate: "2026-01-01",
  version: "2",
};

describe("child-stdin-framing (binary)", () => {
  it("round-trips two raw segments and structural metadata byte for byte", () => {
    const ck = Buffer.from(randomBytes(32));
    const ct = Buffer.from(randomBytes(80));
    const frame = encodeBinaryChildFrame(META, [Buffer.from(ck), Buffer.from(ct)]);
    const decoded = decodeBinaryChildFrame(frame);

    expect(decoded.metadata).toEqual(META);
    expect(decoded.segments).toHaveLength(2);
    expect(decoded.segments[0].equals(ck)).toBe(true);
    expect(decoded.segments[1].equals(ct)).toBe(true);
  });

  it("never places a segment's bytes in the metadata JSON", () => {
    const ck = Buffer.from(randomBytes(32));
    const frame = encodeBinaryChildFrame(META, [Buffer.from(ck), Buffer.from(randomBytes(16))]);
    const metaLen = frame.readUInt32BE(0);
    const json = frame.subarray(4, 4 + metaLen).toString("utf8");
    expect(json.includes(ck.toString("base64"))).toBe(false);
    expect(json.includes(ck.toString("latin1"))).toBe(false);
  });

  it("rejects a numeric metadata value — version must travel as a string", () => {
    expect(() => encodeBinaryChildFrame({ ...META, version: 2 }, [])).toThrow();
  });

  it("rejects secret-named metadata keys", () => {
    expect(() => encodeBinaryChildFrame({ credentials: "x" }, [])).toThrow();
    expect(() => encodeBinaryChildFrame({ dataKey: "x" }, [])).toThrow();
    expect(() => encodeBinaryChildFrame({ flexToken: "x" }, [])).toThrow();
  });

  it("throws on a truncated frame", () => {
    const frame = encodeBinaryChildFrame(META, [Buffer.from(randomBytes(8))]);
    expect(() => decodeBinaryChildFrame(frame.subarray(0, 2))).toThrow();
    expect(() => decodeBinaryChildFrame(frame.subarray(0, frame.length - 2))).toThrow();
  });
});
