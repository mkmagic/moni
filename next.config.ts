import type { NextConfig } from "next";
import { HSTS_VALUE } from "./src/lib/transport";

const nextConfig: NextConfig = {
  // HSTS only (issue #16). CSP, frame and sniffing headers are a separate
  // concern from transit and get their own change.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Strict-Transport-Security", value: HSTS_VALUE }],
      },
    ];
  },
};

export default nextConfig;
