// Length-prefixed binary frame for the scrape-worker child's stdin (docs
// plan §C). The whole reason this exists instead of one JSON blob: the data
// key (DK) must stay a raw `Buffer` end to end. Base64-encoding it into JSON
// would materialize an unwipeable V8 `String`, violating the Tier-0
// invariant (docs/security/threat-model.md §5.5). So the wire format keeps
// DK as raw bytes, length-prefixed, and only the non-key payload (ids,
// dates, and the unavoidably-string bank credentials — the scraper API
// itself takes strings, a documented residual) travels as JSON:
//
//   [4B BE uint32 dataKeyLen][DK raw bytes]
//   [4B BE uint32 jsonLen]   [UTF-8 JSON payload]
//
// Pure functions on purpose (no stdin/process access) so
// tests/unit/child-stdin-framing.test.ts can exercise them without spawning
// a real child process.
export interface ChildStdinPayload {
  syncRunId: string;
  userId: string;
  connectionId: string;
  connectorId: string;
  /** ISO date string, passed straight to `new Date(...)` as the scraper's `startDate`. */
  startDate: string;
  /** Bank/card login credentials. Still plain strings — the scraper API
   * itself takes strings (threat-model.md §5.5's documented residual). */
  credentials: Record<string, string>;
}

const LENGTH_PREFIX_BYTES = 4;

function writeUint32BE(n: number): Buffer {
  const buf = Buffer.alloc(LENGTH_PREFIX_BYTES);
  buf.writeUInt32BE(n, 0);
  return buf;
}

/**
 * Encodes the frame the parent writes to the child's stdin. `dataKey` is
 * copied into the frame as raw bytes — never JSON, never base64.
 */
export function encodeChildStdinFrame(dataKey: Buffer, payload: ChildStdinPayload): Buffer {
  const jsonBuf = Buffer.from(JSON.stringify(payload), "utf8");
  return Buffer.concat([
    writeUint32BE(dataKey.length),
    dataKey,
    writeUint32BE(jsonBuf.length),
    jsonBuf,
  ]);
}

/**
 * Decodes a frame produced by {@link encodeChildStdinFrame}. Throws if the
 * buffer is shorter than the two length prefixes declare (a truncated or
 * malformed frame) rather than reading past the end.
 */
export function decodeChildStdinFrame(buf: Buffer): {
  dataKey: Buffer;
  payload: ChildStdinPayload;
} {
  let offset = 0;

  if (buf.length < LENGTH_PREFIX_BYTES) {
    throw new Error("child-stdin-framing: buffer too short for the data-key length prefix");
  }
  const dataKeyLen = buf.readUInt32BE(offset);
  offset += LENGTH_PREFIX_BYTES;
  if (offset + dataKeyLen > buf.length) {
    throw new Error("child-stdin-framing: truncated frame (data key length exceeds buffer)");
  }
  const dataKey = Buffer.from(buf.subarray(offset, offset + dataKeyLen));
  offset += dataKeyLen;

  if (offset + LENGTH_PREFIX_BYTES > buf.length) {
    throw new Error("child-stdin-framing: buffer too short for the JSON length prefix");
  }
  const jsonLen = buf.readUInt32BE(offset);
  offset += LENGTH_PREFIX_BYTES;
  if (offset + jsonLen > buf.length) {
    throw new Error("child-stdin-framing: truncated frame (JSON length exceeds buffer)");
  }
  const jsonBuf = buf.subarray(offset, offset + jsonLen);
  const payload = JSON.parse(jsonBuf.toString("utf8")) as ChildStdinPayload;

  return { dataKey, payload };
}
