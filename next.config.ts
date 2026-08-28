import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Several sibling projects share this parent folder and each has its own
  // lockfile, so Turbopack's root inference picks the wrong directory and
  // module resolution breaks. Pin it.
  turbopack: { root: __dirname },
  /* config options here */
};

export default nextConfig;
