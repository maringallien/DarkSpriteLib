#!/usr/bin/env node
// Rescales a spritesheet's frames to a target frame size using nearest-neighbour.
// Usage: node scale_frames.mjs <file.png> <srcFrameW> <srcFrameH> <dstFrameW> <dstFrameH>

import fs from "fs";
import path from "path";
import { PNG } from "pngjs";

const [file, sfwS, sfhS, dfwS, dfhS] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node scale_frames.mjs <file.png> <srcFW> <srcFH> <dstFW> <dstFH>");
  process.exit(1);
}

const srcFW = parseInt(sfwS), srcFH = parseInt(sfhS);
const dstFW = parseInt(dfwS), dstFH = parseInt(dfhS);

const src = PNG.sync.read(fs.readFileSync(path.resolve(file)));
const { width: srcW, height: srcH } = src;

if (srcH !== srcFH) {
  console.error(`Height mismatch: file is ${srcH}px tall but srcFrameH=${srcFH}`);
  process.exit(1);
}

const frameCount = Math.round(srcW / srcFW);
const dstW = frameCount * dstFW;
const dst = new PNG({ width: dstW, height: dstFH });

for (let f = 0; f < frameCount; f++) {
  for (let dy = 0; dy < dstFH; dy++) {
    for (let dx = 0; dx < dstFW; dx++) {
      const sx = Math.min(srcFW - 1, Math.round(dx * srcFW / dstFW));
      const sy = Math.min(srcFH - 1, Math.round(dy * srcFH / dstFH));
      const si = (sy * srcW + f * srcFW + sx) * 4;
      const di = (dy * dstW + f * dstFW + dx) * 4;
      dst.data[di]     = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}

fs.writeFileSync(path.resolve(file), PNG.sync.write(dst));
console.log(`${path.basename(file)}: ${srcW}×${srcH} (${frameCount}×${srcFW}×${srcFH}) → ${dstW}×${dstFH} (${frameCount}×${dstFW}×${dstFH})`);
