/// <reference types="vite/client" />

/**
 * Typed environment variables exposed to the Simple View at build time.
 *
 * `VITE_INSIGHT_API_URL` points the dashboard at the Insight_Service JSON API.
 * It is optional; when unset the app falls back to same-origin requests. See
 * App.tsx (task 9.3).
 */
interface ImportMetaEnv {
  readonly VITE_INSIGHT_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
