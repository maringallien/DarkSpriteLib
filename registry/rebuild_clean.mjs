#!/usr/bin/env node
// Reconstructs the original-width PNG by inserting transparent columns
// back at the known purple-line positions, then saves the clean file.

import fs from "fs";
import path from "path";
import { PNG } from "pngjs";

// The purple bands that were removed (original x positions in the 592px file)
const PURPLE_POSITIONS = [2, 59, 145, 220, 295, 369, 444, 516, 590];
const ORIGINAL_WIDTH = 592;

const filePath = path.resolve(process.argv[2]);
const data = fs.readFileSync(filePath);
const src = PNG.sync.read(data);
const { width: srcW, height: H } = src;

console.log(`Source: ${srcW}×${H}`);
console.log(`Target: ${ORIGINAL_WIDTH}×${H}`);

const dst = new PNG({ width: ORIGINAL_WIDTH, height: H });
// Fill with fully transparent pixels
dst.data.fill(0);

// Build a set of purple positions for O(1) lookup
const purpleSet = new Set(PURPLE_POSITIONS);

// Copy pixels: for each column in dst, skip purple positions,
// filling from src sequentially.
let srcX = 0;
for (let dstX = 0; dstX < ORIGINAL_WIDTH; dstX++) {
  if (purpleSet.has(dstX)) {
    // Leave transparent (already zeroed)
    continue;
  }
  for (let y = 0; y < H; y++) {
    const si = (y * srcW + srcX) * 4;
    const di = (y * ORIGINAL_WIDTH + dstX) * 4;
    dst.data[di]     = src.data[si];
    dst.data[di + 1] = src.data[si + 1];
    dst.data[di + 2] = src.data[si + 2];
    dst.data[di + 3] = src.data[si + 3];
  }
  srcX++;
}

fs.writeFileSync(filePath, PNG.sync.write(dst));
console.log(`Written: ${filePath} (${ORIGINAL_WIDTH}×${H})`);
console.log(`Frame width: ${ORIGINAL_WIDTH} / 8 frames = ${ORIGINAL_WIDTH / 8}px`);
