import path from "node:path";

export function workerRuntimePath(...segments: string[]): string {
  return path.join(process.env.MONI_APP_ROOT ?? process.cwd(), ...segments);
}
