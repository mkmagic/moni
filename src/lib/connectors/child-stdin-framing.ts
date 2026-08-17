// Binary child-process framing. Secrets stay in raw segments; JSON is limited
// to structural metadata, which `assertStructuralMetadata` enforces.
const PREFIX = 4;
export const MAX_CHILD_STDIN_BYTES = 10 * 1024 * 1024;
/** A source segment may be 10 MiB; metadata/framing gets a small separate budget. */
export const MAX_CHILD_SEGMENT_BYTES = 10 * 1024 * 1024;
export const MAX_CHILD_METADATA_BYTES = 64 * 1024;
export const MAX_CHILD_FRAME_BYTES = MAX_CHILD_SEGMENT_BYTES + MAX_CHILD_METADATA_BYTES;
export const MAX_CHILD_SEGMENTS = 4;

function uint(n: number): Buffer {
  const value = Buffer.alloc(PREFIX);
  value.writeUInt32BE(n);
  return value;
}

function checkedSegmentLength(value: number): void {
  if (value > MAX_CHILD_SEGMENT_BYTES) throw new Error("child-stdin-framing: segment too large");
}

function assertStructuralMetadata(value: unknown, key = ""): void {
  if (/token|query|credential|secret|csv|data.?key/i.test(key))
    throw new Error("child-stdin-framing: sensitive metadata is forbidden");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "undefined")
    throw new Error("child-stdin-framing: metadata must be structural JSON");
  if (Array.isArray(value)) {
    for (const item of value) assertStructuralMetadata(item);
    return;
  }
  if (typeof value === "object")
    for (const [childKey, child] of Object.entries(value))
      assertStructuralMetadata(child, childKey);
}

/** Frame layout: metadata length, metadata JSON, segment count, raw segments. */
export function encodeBinaryChildFrame(
  metadata: Record<string, unknown>,
  segments: Buffer[],
): Buffer {
  assertStructuralMetadata(metadata);
  if (segments.length > MAX_CHILD_SEGMENTS)
    throw new Error("child-stdin-framing: too many segments");
  const json = Buffer.from(JSON.stringify(metadata), "utf8");
  if (json.length > MAX_CHILD_METADATA_BYTES)
    throw new Error("child-stdin-framing: metadata too large");
  const pieces = [uint(json.length), json, uint(segments.length)];
  let length = PREFIX + json.length + PREFIX;
  for (const segment of segments) {
    checkedSegmentLength(segment.length);
    length += PREFIX + segment.length;
    if (length > MAX_CHILD_FRAME_BYTES) throw new Error("child-stdin-framing: frame too large");
    pieces.push(uint(segment.length), segment);
  }
  return Buffer.concat(pieces, length);
}

export function decodeBinaryChildFrame(frame: Buffer): {
  metadata: Record<string, unknown>;
  segments: Buffer[];
} {
  if (frame.length > MAX_CHILD_FRAME_BYTES) throw new Error("child-stdin-framing: frame too large");
  let offset = 0;
  const read = (): number => {
    if (offset + PREFIX > frame.length)
      throw new Error("child-stdin-framing: truncated length prefix");
    const length = frame.readUInt32BE(offset);
    offset += PREFIX;
    return length;
  };
  const take = (length: number): Buffer => {
    checkedSegmentLength(length);
    if (offset + length > frame.length) throw new Error("child-stdin-framing: truncated frame");
    const result = Buffer.from(frame.subarray(offset, offset + length));
    offset += length;
    return result;
  };
  const json = take(read());
  const segments: Buffer[] = [];
  let decoded = false;
  try {
    const parsed: unknown = JSON.parse(json.toString("utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    assertStructuralMetadata(parsed);
    const count = read();
    if (count > MAX_CHILD_SEGMENTS) throw new Error("child-stdin-framing: too many segments");
    for (let index = 0; index < count; index += 1) segments.push(take(read()));
    if (offset !== frame.length) throw new Error("child-stdin-framing: trailing bytes");
    decoded = true;
    return { metadata: parsed as Record<string, unknown>, segments };
  } finally {
    json.fill(0);
    // On a failed decode no child owns the already-copied segments (which may be
    // secret keys), so clear them here. `offset === frame.length` isn't a safe
    // success signal — a truncation landing exactly on a segment boundary also
    // leaves offset at the end — so key off an explicit success flag instead.
    if (!decoded) for (const segment of segments) segment.fill(0);
  }
}
