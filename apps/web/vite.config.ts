import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { injectDevApiProxyAuth } from "./devApiProxyAuth";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.CONSISTENCY_DEV_API_TARGET ?? "http://127.0.0.1:8787",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, ""),
        // Dev-server only for local web dogfood: inject API/desktop tokens from
        // process.env onto proxied requests. Production/Electron must not rely on this.
        configure: proxy => {
          proxy.on("proxyReq", proxyReq => {
            injectDevApiProxyAuth(proxyReq);
          });
        }
      }
    }
  }
});
