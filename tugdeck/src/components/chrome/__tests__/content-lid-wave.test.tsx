/**
 * content-lid-wave — the wave a lidded content box wears runs.
 */

import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ContentLidWave } from "../content-lid-wave";

describe("ContentLidWave", () => {
  test("its wave is running, not the indicator's stopped default", () => {
    const html = renderToStaticMarkup(<ContentLidWave />);
    expect(html).toContain('data-slot="tug-progress-wave"');
    expect(html).toMatch(/data-slot="tug-progress-wave" data-state="running"/);
  });
});
