// electron.vite.config.ts
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
var __electron_vite_injected_dirname = "D:\\Code_zkelvins\\GenOffice\\genoffice\\apps\\shell";
var electron_vite_config_default = defineConfig({
  // Bundle everything into the shell main (same policy as apps/docs): the
  // imported docs/sheets main modules are TS source with no build artifacts,
  // so externalizing them would break Node ESM resolution at runtime.
  main: {},
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/preload/index.ts"),
          // dedicated preload for the auto-update window
          update: resolve(__electron_vite_injected_dirname, "src/preload/update.ts"),
          // dedicated preload for the PDF password prompt window
          "pdf-password": resolve(__electron_vite_injected_dirname, "src/preload/pdf-password.ts")
        }
      }
    }
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html"),
          // strong-guidance update window (see src/main/update-window.ts)
          update: resolve(__electron_vite_injected_dirname, "src/renderer/update.html"),
          // PDF password prompt window (see src/main/pdf-password-dialog.ts)
          "pdf-password": resolve(__electron_vite_injected_dirname, "src/renderer/pdf-password.html")
        }
      }
    },
    server: {
      port: Number(process.env.SHELL_DEV_PORT) || 5199,
      strictPort: Boolean(process.env.SHELL_DEV_PORT)
    }
  }
});
export {
  electron_vite_config_default as default
};
