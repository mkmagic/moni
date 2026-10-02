import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const require = createRequire(import.meta.url);

describe("production deployment hardening", () => {
  it("locks the patched framework and browser toolchain without extract-zip", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };
    const lock = read("package-lock.json");

    expect(packageJson.dependencies.next).toBe("16.3.5");
    expect(packageJson.dependencies.sharp).toBe("0.35.4");
    expect(packageJson.dependencies.puppeteer).toBe("25.11.0");
    expect(lock).not.toContain('"node_modules/extract-zip"');
    expect(lock).not.toContain('"node_modules/yauzl"');
  });

  it("pins the reviewed Chrome artifact and carries it in the release manifest", () => {
    const browser = read("deploy/chrome-for-testing.env");
    const packager = read("deploy/package-release.sh");
    const revisions = require("puppeteer-core/internal/revisions.js") as {
      PUPPETEER_REVISIONS: { chrome: string };
    };

    expect(browser).toContain('CHROME_VERSION="153.0.8010.36"');
    expect(revisions.PUPPETEER_REVISIONS.chrome).toBe("153.0.8010.36");
    expect(browser).toContain(
      'CHROME_SHA256="167a098c4fdec156b58a9f678c90a84f9072d789f9c6e7b35496a6987b8b7ef8"',
    );
    expect(packager).toContain(".moni-chrome-version");
    expect(packager).toContain(".moni-chrome-sha256");
  });

  it("verifies Chrome before safe extraction and installs it root-owned", () => {
    const release = read("deploy/release.sh");

    expect(release).toContain('sha256sum -c "$CHROME_CHECKSUM"');
    expect(release).toContain("unsafe Chrome archive path");
    expect(release).toContain("unsafe Chrome archive entry type");
    expect(release).toContain("chown -R root:root");
    expect(release).toContain("chmod -R go-w");
  });

  it("rejects request bodies above the upload limit plus multipart overhead", () => {
    expect(read("deploy/Caddyfile.production")).toContain("max_size 11MiB");
  });

  it("reconciles and verifies the Caddy override on every release", () => {
    const release = read("deploy/release.sh");
    const override = read("deploy/caddy.service.conf");

    expect(override).toContain("LimitCORE=0");
    expect(override).toContain("NoNewPrivileges=yes");
    expect(override).toContain("CapabilityBoundingSet=CAP_NET_BIND_SERVICE");
    expect(override).not.toMatch(/^AmbientCapabilities=.*CAP_NET_ADMIN/m);
    expect(override).not.toMatch(/^CapabilityBoundingSet=.*CAP_NET_ADMIN/m);
    expect(release).toContain("/etc/systemd/system/caddy.service.d/override.conf");
    expect(release).toContain("verify_caddy_hardening");
  });

  it("uses the immutable release marker and fails closed on unknown revisions", () => {
    const verifier = read("deploy/verify-host.sh");

    expect(verifier).toContain('MARKER="$APP/.moni-release-sha"');
    expect(verifier).toContain("release marker missing or invalid");
    expect(verifier).not.toContain('git -C "$APP"');
  });
});
