#!/usr/bin/env node
// Converts vertical sprite strips (frames top-to-bottom) to horizontal strips
// (frames left-to-right). Assumes square frames (width × width per frame).

import fs from "fs";
import path from "path";
import { PNG } from "pngjs";

function convert(filePath) {
  const data = fs.readFileSync(filePath);
  const src = PNG.sync.read(data);
  const { width: frameSize, height: totalHeight } = src;

  if (totalHeight % frameSize !== 0) {
    console.warn(`  SKIP ${filePath}: height ${totalHeight} not divisible by width ${frameSize}`);
    return;
  }

  const frameCount = totalHeight / frameSize;
  if (frameCount <= 1) {
    console.log(`  SKIP ${filePath}: single frame, nothing to do`);
    return;
  }

  const dst = new PNG({ width: totalHeight, height: frameSize });

  for (let frame = 0; frame < frameCount; frame++) {
    for (let y = 0; y < frameSize; y++) {
      for (let x = 0; x < frameSize; x++) {
        // Source: pixel (x, frame*frameSize + y) in vertical strip
        const si = ((frame * frameSize + y) * frameSize + x) * 4;
        // Dest: pixel (frame*frameSize + x, y) in horizontal strip
        const di = (y * totalHeight + frame * frameSize + x) * 4;
        dst.data[di]     = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = src.data[si + 3];
      }
    }
  }

  fs.writeFileSync(filePath, PNG.sync.write(dst));
  console.log(`  ${path.basename(filePath)}: ${frameSize}×${totalHeight} → ${totalHeight}×${frameSize} (${frameCount} frames)`);
}

const args = process.argv.slice(2);
for (const f of args) convert(path.resolve(f));
