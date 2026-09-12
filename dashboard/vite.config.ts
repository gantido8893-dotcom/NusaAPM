/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Simple View build config for the Personal AI-Powered APM System.
// Single-user, no auth (Requirement 14.2); consumes the Insight_Service JSON API.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
  },
});
