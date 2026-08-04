/** Concatenates stdin while clearing the stream-owned input chunks. */
export async function readChildStdin(input: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of input) chunks.push(chunk);
    return Buffer.concat(chunks);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}
