import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerRuntimePath } from "@/lib/worker-runtime";

describe("workerRuntimePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses the configured app root when the standalone server changes cwd", () => {
    vi.stubEnv("MONI_APP_ROOT", "/opt/moni/app");
    vi.spyOn(process, "cwd").mockReturnValue("/opt/moni/app/.next/standalone");

    expect(workerRuntimePath("node_modules", ".bin", "tsx")).toBe(
      "/opt/moni/app/node_modules/.bin/tsx",
    );
    expect(workerRuntimePath("scripts", "scrape-worker.mts")).toBe(
      "/opt/moni/app/scripts/scrape-worker.mts",
    );
  });

  it("configures the production service with the stable app root", async () => {
    const service = await readFile("deploy/moni.service", "utf8");

    expect(service).toContain("Environment=MONI_APP_ROOT=/opt/moni/app");
  });
});
