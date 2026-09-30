import { describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { handleThemesActivate } from "../../vite.config";

describe("theme activate endpoint (thin)", () => {
  it("activates sloop and returns its hostCanvasColor", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tugdeck-theme-activate-"));
    try {
      const themesCssDir = path.join(tmpDir, "themes");
      fs.mkdirSync(themesCssDir, { recursive: true });
      fs.writeFileSync(
        path.join(themesCssDir, "sloop.css"),
        "body { --tugx-host-canvas-color: #e7eaf0; --tug-sample: #123456; }",
        "utf-8",
      );

      const result = await handleThemesActivate({ theme: "sloop" }, themesCssDir);

      expect(result.status).toBe(200);
      expect(result.body).toContain("\"theme\":\"sloop\"");
      expect(result.body).toContain("\"hostCanvasColor\":\"#e7eaf0\"");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("404s on an unknown theme", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tugdeck-theme-activate-"));
    try {
      const themesCssDir = path.join(tmpDir, "themes");
      fs.mkdirSync(themesCssDir, { recursive: true });

      const result = await handleThemesActivate({ theme: "does-not-exist" }, themesCssDir);

      expect(result.status).toBe(404);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
