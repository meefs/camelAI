process.env.DESKTOP_BACKEND_MODULE_ENTRY ||=
  "desktop-agentos/backend/electron-service.ts";

await import("../../desktop/electron/main.mjs");
