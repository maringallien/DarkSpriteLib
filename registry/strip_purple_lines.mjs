#!/usr/bin/env node
// Scans a PNG for purple marker lines (#f311e7), reports frame layout,
// strips the purple pixels, and writes a clean PNG to the same path.

import fs from "fs";
import path from "path";
import { PNG } from "pngjs";

const PURPLE = { r: 243, g: 17, b: 231 };
const TOLERANCE = 20; // per-channel tolerance

function isPurple(r, g, b) {
  return (
    Math.abs(r - PURPLE.r) <= TOLERANCE &&
    Math.abs(g - PURPLE.g) <= TOLERANCE &&
    Math.abs(b - PURPLE.b) <= TOLERANCE
  );
}

function analyze(filePath) {
  const data = fs.readFileSync(filePath);
  const png = PNG.sync.read(data);
  const { width, height } = png;

  // Find all x columns that contain at least one purple pixel
  const purpleColumns = new Set();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      if (isPurple(r, g, b)) {
        purpleColumns.add(x);
      }
    }
  }

  // Group consecutive purple columns into "line bands"
  const sorted = [...purpleColumns].sort((a, b) => a - b);
  const bands = []; // [{start, end}]
  let bandStart = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] > prev + 1) {
      bands.push({ start: bandStart, end: prev });
      bandStart = sorted[i];
    }
    prev = sorted[i];
  }
  if (sorted.length > 0) bands.push({ start: bandStart, end: prev });

  console.log(`Image: ${width}×${height}`);
  console.log(`Purple column bands (${bands.length}):`);
  bands.forEach((b, i) => {
    const w = b.end - b.start + 1;
    console.log(`  Band ${i}: x=${b.start}–${b.end} (${w}px wide)`);
  });

  // Derive frames: regions between bands (and before first / after last)
  // Each frame starts right after a band end and ends right before the next band start.
  const frameRegions = [];
  const leftEdge = 0;
  const rightEdge = width - 1;

  // Before first band
  if (bands.length > 0 && bands[0].start > leftEdge) {
    frameRegions.push({ x: leftEdge, w: bands[0].start - leftEdge });
  }

  for (let i = 0; i < bands.length - 1; i++) {
    const x = bands[i].end + 1;
    const w = bands[i + 1].start - x;
    if (w > 0) frameRegions.push({ x, w });
  }

  // After last band
  if (bands.length > 0) {
    const x = bands[bands.length - 1].end + 1;
    const w = rightEdge - x + 1;
    if (w > 0) frameRegions.push({ x, w });
  }

  console.log(`\nFrame regions (${frameRegions.length}):`);
  frameRegions.forEach((f, i) => console.log(`  Frame ${i}: x=${f.x}, w=${f.w}`));

  // Check if all frames have the same width
  const widths = frameRegions.map(f => f.w);
  const uniqueWidths = [...new Set(widths)];
  if (uniqueWidths.length === 1) {
    console.log(`\nAll frames are ${uniqueWidths[0]}px wide — uniform ✓`);
  } else {
    console.log(`\nFrame widths vary: ${widths.join(", ")}`);
  }

  // Strip purple lines: make purple pixels transparent (alpha=0)
  const stripped = PNG.sync.read(data); // fresh copy
  for (const col of purpleColumns) {
    for (let y = 0; y < height; y++) {
      const idx = (y * width + col) * 4;
      stripped.data[idx] = 0;
      stripped.data[idx + 1] = 0;
      stripped.data[idx + 2] = 0;
      stripped.data[idx + 3] = 0; // fully transparent
    }
  }

  // Write clean PNG in-place (same dimensions, purple pixels now transparent)
  const outPath = filePath;
  fs.writeFileSync(outPath, PNG.sync.write(stripped));
  console.log(`\nStripped PNG written to: ${outPath}`);
  console.log(`Dimensions unchanged: ${width}×${height} (purple pixels made transparent)`);

  return { frameCount: frameRegions.length, frameWidth: uniqueWidths[0] ?? widths[0], frameHeight: height, cleanWidth };
}

const file = process.argv[2];
if (!file) {
  console.error("Usage: node strip_purple_lines.mjs <path/to/sprite.png>");
  process.exit(1);
}

analyze(path.resolve(file));
