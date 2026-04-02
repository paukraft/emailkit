import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/nextjs.ts"],
  platform: "node",
  dts: true,
  // Keep Next.js and React external for adapters
  external: ["next", "next/server", "react", "react-dom"],
  // Avoid infinite watch loops triggered by Turborepo logs and build outputs
  ignoreWatch: [".turbo/**", "dist/**", "node_modules/**"],
});
