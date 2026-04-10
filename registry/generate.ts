#!/usr/bin/env npx tsx
// ─────────────────────────────────────────────────────────────────────────────
// DarkSpriteLib – Registry Generator
//
// Run from the repo root:
//   npx tsx registry/generate.ts
//
// Outputs:
//   registry/registry.json               ← master registry
//   registry/characters/<id>.json        ← per-character
//   registry/playable_character.json
//   registry/validation_report.txt
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";

import {
  normalize,
  assignOrdinals,
  isProjectileStem,
  projectilePartKey,
  stripPrefix,
  SEQUENCE_RULES,
} from "./normalization.js";

import type {
  AnyAnimation,
  AnyCharacter,
  AnimationWithProjectile,
  FrameData,
  PlayableCharacter,
  PlayableCharacterMode,
  ProjectileState,
  Registry,
  SequenceAnimation,
  SequencePart,
  SimpleAnimation,
  StandardCharacter,
  ValidationIssue,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dirname, "..");
const CHARS_DIR = path.join(ROOT, "characters");
const PLAYABLE_DIR = path.join(ROOT, "playable_character");
const OUT_DIR = path.join(ROOT, "registry");
const OUT_CHARS_DIR = path.join(OUT_DIR, "characters");

// ---------------------------------------------------------------------------
// PNG frame-size heuristic
//
// Sprite sheets in DarkSpriteLib are single-row horizontal strips:
//   - frameHeight = sheetHeight  (the strip height is always one frame tall)
//   - frameWidth  = GCD of all sheet widths within the same character
//                   (all animations share the same frame dimensions)
//
// We compute frameWidth once per character by grouping files by height and
// taking the GCD of widths within each height group.  Files at different
// heights (e.g. a VFX sheet taller than the character) are tracked separately.
// ---------------------------------------------------------------------------

function gcd(a: number, b: number): number {
  while (b) { const t = b; b = a % b; a = t; }
  return a;
}

function gcdList(nums: number[]): number {
  return nums.reduce(gcd);
}

function readPngDimensions(filePath: string): { w: number; h: number } | null {
  try {
    const buf = Buffer.alloc(24);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    // PNG signature: 8 bytes, then IHDR chunk: 4-len, 4-type, 4-width, 4-height
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return { w, h };
  } catch {
    return null;
  }
}

/**
 * Pre-compute frame dimensions for a set of files belonging to the same character.
 * Returns a Map<filePath, FrameData> for use during animation building.
 *
 * Strategy:
 *  1. Read all PNG dimensions
 *  2. Group files by height (frameHeight = sheetHeight for single-row strips)
 *  3. Compute GCD of widths per height group → that is frameWidth for that group
 *  4. If GCD is suspiciously small (< frameHeight / 3), flag those files as ambiguous
 */
function precomputeFrameData(files: string[], characterId?: string): Map<string, FrameData & { ambiguous: boolean }> {
  const result = new Map<string, FrameData & { ambiguous: boolean }>();

  // Step 1: read all dimensions
  const dims = new Map<string, { w: number; h: number }>();
  for (const f of files) {
    const d = readPngDimensions(f);
    if (d) dims.set(f, d);
    else result.set(f, { sheetWidth: 0, sheetHeight: 0, frameWidth: 0, frameHeight: 0, frameCount: 0, ambiguous: true });
  }

  // Step 2: group by height
  const byHeight = new Map<number, Array<{ file: string; w: number }>>();
  for (const [file, { w, h }] of dims) {
    if (!byHeight.has(h)) byHeight.set(h, []);
    byHeight.get(h)!.push({ file, w });
  }

  // Step 3: compute GCD per height group and assign frame data
  for (const [h, group] of byHeight) {
    const widths = group.map((g) => g.w);
    let frameWidth = widths.length > 1 ? gcdList(widths) : widths[0];

    // Apply explicit per-character override if present, otherwise use heuristic.
    const override = characterId ? FRAME_WIDTH_OVERRIDES[characterId] : undefined;
    if (override !== undefined) {
      frameWidth = override;
    } else {
      // Correct over-estimated GCD: when all frame counts share a common factor k,
      // gcdList returns k × trueFrameWidth. Halve while ratio > 3.0 and still even.
      while (frameWidth % 2 === 0 && frameWidth / h > 3.0) {
        frameWidth = frameWidth / 2;
      }
    }

    // Step 4: flag if frameWidth is suspiciously small
    const ambiguous = frameWidth < h / 3;

    for (const { file, w } of group) {
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      const fileOverride = FILE_FRAME_OVERRIDES[rel];
      const fw = fileOverride?.frameWidth ?? frameWidth;
      const fh = fileOverride?.frameHeight ?? h;
      result.set(file, {
        sheetWidth: w,
        sheetHeight: h,
        frameWidth: fw,
        frameHeight: fh,
        frameCount: fw > 0 ? Math.round((w / fw) * (h / fh)) : 1,
        ambiguous,
      });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stemOf(filename: string): string {
  return path.basename(filename, path.extname(filename)).toLowerCase().trim();
}

function relPath(absPath: string): string {
  return path.relative(ROOT, absPath).replace(/\\/g, "/");
}

function listPngs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".png"))
    .map((f) => path.join(dir, f));
}

// ---------------------------------------------------------------------------
// Composite / variant character detection overrides
//
// These characters require special handling because their subdirectories are
// independent components or visual variants rather than animation sub-folders.
// ---------------------------------------------------------------------------

type CharacterOverride =
  | { type: "composite"; components: Record<string, string> }  // componentKey → subdir name
  | { type: "variant";   variants:   Record<string, string> }; // variantKey  → subdir name

const CHARACTER_OVERRIDES: Record<string, CharacterOverride> = {
  the_bone_reaper: {
    type: "composite",
    components: {
      hand:      "hand",
      head:      "head",
      orb_black: "orb_black",
      orb_white: "orb_white",
    },
  },
  lord_of_the_poisons: {
    type: "variant",
    variants: {
      no_glow:   "sprite_no_glow",
      with_glow: "sprite_with_glow",
    },
  },
  "sci-fi_samurai": {
    type: "variant",
    variants: {
      sword:  "with_sword",
      spear:  "with_spear",
    },
  },
  bo_panda: {
    type: "variant",
    variants: {
      good: "good_bo_panda",
      evil: "evil_bo_panda",
    },
  },
  a_strange_companion: {
    type: "variant",
    variants: {
      default: ".",
      red:     ".",  // color variants are in same dir, handled differently
      teal:    ".",
    },
  },
  colossal_boss: {
    type: "composite",
    components: {
      body: ".",
    },
  },
};

// ---------------------------------------------------------------------------
// Per-character explicit stem → final animation key overrides.
// Use when alphabetical ordinal assignment produces wrong numbering.
// ---------------------------------------------------------------------------

const STEM_KEY_OVERRIDES: Record<string, Record<string, string>> = {
  ancient_guardian: {
    "guardian-blast":        "attack3",
    "guardian-laser_attack": "attack2",
  },
  archer: {
    "attack":          "attack1",
    "special_attack":  "attack2",
  },
  doberman: {
    "dog-bark":               "bark",
    "dog-bite":               "attack1",
    "dog-get_up":             "get_up",
    "dog-idle":               "idle",
    "dog-lay_down_idle":      "lie",
    "dog-ledge_climb":        "ledge_grab",
    "dog-sit":                "sit_down",
    "dog-sit_idle":           "sit",
    "dog-sleep":              "sleep",
    "dog-stand":              "sit_up",
    "dog-to_sleep":           "go_sleep",
    "dog-wake_up_transition": "wake_up",
    "eat":                    "sniff",
  },
};

// Stems to exclude entirely from a character's animation list.
const STEM_EXCLUSIONS: Record<string, Set<string>> = {
  ancient_guardian: new Set(["shield_spritesheet"]),
  archer:           new Set(["vfx_for_special", "special_attack_vanish"]),
  archer_bandit:    new Set(["archer_bandit-fall", "archer_bandit-jump"]),
  bomb_droid:       new Set(["idle"]),
  doberman:         new Set(["dog-ledge_grab", "dog"]),
};

// Override the auto-detected frameWidth for a character (all files share one height group).
// Use when the GCD halving heuristic over- or under-corrects.
// Per-character frameWidth overrides, keyed by character id.
// When a character has only one file at a given height, GCD = full sheet width (1 frame).
// Also used when the halving heuristic over- or under-corrects.
const FRAME_WIDTH_OVERRIDES: Record<string, number> = {
  archer: 174,
  caged_spider: 43,
};

// Per-file frame dimension overrides (relative path from repo root).
// Use for grid sheets (multiple rows) or isolated files with known dimensions.
const FILE_FRAME_OVERRIDES: Record<string, { frameWidth: number; frameHeight: number }> = {
  "characters/archer_bandit/volley_vfx.png":       { frameWidth: 74,  frameHeight: 111 },
  "characters/dream_merchant1/genie_merchant.png":  { frameWidth: 90,  frameHeight: 63  },
  "characters/dream_merchant2/magic_merchant.png":  { frameWidth: 65,  frameHeight: 49  },
  "characters/dream_merchant3/time_traveler_npc.png": { frameWidth: 64,  frameHeight: 82 },
};

// ---------------------------------------------------------------------------
// Core: build a StandardCharacter from a flat list of PNG files
// ---------------------------------------------------------------------------

function buildStandardCharacter(
  id: string,
  dirPath: string,
  files: string[],
  issues: ValidationIssue[],
): StandardCharacter {
  const animations: Record<string, AnyAnimation> = {};

  // Pre-compute frame data for all files in this character at once
  const frameMap = precomputeFrameData(files, id);

  function getFrames(file: string): { frames: FrameData; ambiguous: boolean } {
    const { ambiguous, ...frames } = frameMap.get(file) ?? {
      sheetWidth: 0, sheetHeight: 0, frameWidth: 0, frameHeight: 0, frameCount: 0, ambiguous: true,
    };
    return { frames, ambiguous };
  }

  // Separate projectile files from animation files
  const projectileFiles = files.filter((f) => isProjectileStem(stemOf(f)));
  const animFiles = files.filter((f) => !isProjectileStem(stemOf(f)));

  // ── 1. Check for sequence matches ─────────────────────────────────────────
  const usedFiles = new Set<string>();

  for (const rule of SEQUENCE_RULES) {
    const resolvedParts: { partKey: string; file: string; stem: string }[] = [];

    for (const { partKey, stemPatterns } of rule.parts) {
      const match = animFiles.find(
        (f) => !usedFiles.has(f) && stemPatterns.some((p) => {
          const s = stemOf(f);
          return s === p || s.includes(p) || (s.includes("-") && stripPrefix(s) === p);
        }),
      );
      if (match) resolvedParts.push({ partKey, file: match, stem: stemOf(match) });
    }

    // Only emit a sequence if at least 2 parts were found
    if (resolvedParts.length >= 2) {
      const parts: SequencePart[] = resolvedParts.map(({ partKey, file, stem }) => {
        const { frames, ambiguous } = getFrames(file);
        if (ambiguous) {
          issues.push({ characterId: id, severity: "warning", message: `Ambiguous frame size for sequence part "${stem}"`, file: relPath(file) });
        }
        return { key: partKey, file: relPath(file), loops: false, frames, originalName: stem };
      });

      const seq: SequenceAnimation = { type: "sequence", key: rule.sequenceKey, category: rule.category, parts };
      animations[rule.sequenceKey] = seq;
      resolvedParts.forEach(({ file }) => usedFiles.add(file));
    }
  }

  // ── 2. Normalize remaining animation files ────────────────────────────────
  // Group by baseKey to assign ordinals
  const byBaseKey: Record<string, string[]> = {};

  for (const file of animFiles) {
    if (usedFiles.has(file)) continue;
    const stem = stemOf(file);
    if (STEM_EXCLUSIONS[id]?.has(stem)) continue;
    const rule = normalize(stem);
    if (!rule) {
      issues.push({ characterId: id, severity: "warning", message: `Unrecognised animation stem "${stem}" — added as-is`, file: relPath(file) });
      const { frames, ambiguous } = getFrames(file);
      if (ambiguous) issues.push({ characterId: id, severity: "warning", message: `Ambiguous frame size for "${stem}"`, file: relPath(file) });
      animations[stem] = {
        type: "simple", key: stem, file: relPath(file),
        category: "attack", loops: false, frames, originalName: stem,
      } satisfies SimpleAnimation;
      continue;
    }

    if (!byBaseKey[rule.baseKey]) byBaseKey[rule.baseKey] = [];
    byBaseKey[rule.baseKey].push(stem);
  }

  // Build ordinal map and emit
  const stemToKey: Record<string, string> = {};
  for (const [baseKey, stems] of Object.entries(byBaseKey)) {
    const ordinals = assignOrdinals(baseKey, stems);
    Object.assign(stemToKey, ordinals);
  }

  for (const file of animFiles) {
    if (usedFiles.has(file)) continue;
    const stem = stemOf(file);
    if (STEM_EXCLUSIONS[id]?.has(stem)) continue;
    const rule = normalize(stem);
    if (!rule) continue; // already handled above

    const normalizedKey = STEM_KEY_OVERRIDES[id]?.[stem] ?? stemToKey[stem] ?? rule.baseKey;
    const { frames, ambiguous } = getFrames(file);
    if (ambiguous) issues.push({ characterId: id, severity: "warning", message: `Ambiguous frame size for "${stem}"`, file: relPath(file) });

    animations[normalizedKey] = {
      type: "simple",
      key: normalizedKey,
      file: relPath(file),
      category: rule.category,
      loops: rule.loops,
      frames,
      originalName: stem,
    } satisfies SimpleAnimation;
  }

  // ── 3. Link projectiles to the nearest ranged/attack animation ────────────
  if (projectileFiles.length > 0) {
    const rangedKey = Object.keys(animations).find((k) => k.startsWith("ranged"))
      ?? Object.keys(animations).find((k) => k.startsWith("attack"));

    const projectileStates: ProjectileState[] = projectileFiles.map((file) => {
      const stem = stemOf(file);
      const { frames, ambiguous } = getFrames(file);
      if (ambiguous) issues.push({ characterId: id, severity: "warning", message: `Ambiguous frame size for projectile "${stem}"`, file: relPath(file) });
      return { key: projectilePartKey(stem), file: relPath(file), loops: stem.includes("idle"), frames, originalName: stem };
    });

    if (rangedKey && animations[rangedKey]?.type === "simple") {
      const base = animations[rangedKey] as SimpleAnimation;
      const withProj: AnimationWithProjectile = { ...base, type: "with_projectile", projectile: projectileStates };
      animations[rangedKey] = withProj;
    } else {
      for (const ps of projectileStates) {
        animations[`projectile_${ps.key}`] = {
          type: "simple", key: `projectile_${ps.key}`, file: ps.file,
          category: "ranged", loops: ps.loops, frames: ps.frames, originalName: ps.originalName,
        } satisfies SimpleAnimation;
      }
    }
  }

  // ── 4. Validate critical animations ──────────────────────────────────────
  if (!animations["idle"]) {
    issues.push({ characterId: id, severity: "warning", message: "Missing idle animation" });
  }
  if (!animations["death"]) {
    issues.push({ characterId: id, severity: "warning", message: "Missing death animation" });
  }

  return { type: "standard", id, path: relPath(dirPath), animations };
}

// ---------------------------------------------------------------------------
// Build a character entry (standard / composite / variant)
// ---------------------------------------------------------------------------

function buildCharacter(
  id: string,
  dirPath: string,
  issues: ValidationIssue[],
): AnyCharacter {
  const override = CHARACTER_OVERRIDES[id];

  if (override?.type === "composite") {
    const components: Record<string, StandardCharacter> = {};
    for (const [compKey, subdir] of Object.entries(override.components)) {
      const compDir = subdir === "." ? dirPath : path.join(dirPath, subdir);
      const files = listPngs(compDir);
      components[compKey] = buildStandardCharacter(`${id}/${compKey}`, compDir, files, issues);
      components[compKey].id = compKey;
    }
    return { type: "composite", id, path: relPath(dirPath), components };
  }

  if (override?.type === "variant") {
    const variants: Record<string, StandardCharacter> = {};
    for (const [varKey, subdir] of Object.entries(override.variants)) {
      const varDir = subdir === "." ? dirPath : path.join(dirPath, subdir);
      const files = listPngs(varDir);
      variants[varKey] = buildStandardCharacter(`${id}/${varKey}`, varDir, files, issues);
      variants[varKey].id = varKey;
    }
    return { type: "variant", id, path: relPath(dirPath), variants };
  }

  // Standard character — files are directly in the dir (or in an animations subdir)
  let files = listPngs(dirPath);

  // Some characters may have a single level of subdirectories containing PNGs
  // (e.g. lord_of_the_poisons without override). Collect all.
  if (files.length === 0) {
    const subdirs = fs.readdirSync(dirPath)
      .map((d) => path.join(dirPath, d))
      .filter((d) => fs.statSync(d).isDirectory());
    for (const sub of subdirs) files = files.concat(listPngs(sub));
  }

  return buildStandardCharacter(id, dirPath, files, issues);
}

// ---------------------------------------------------------------------------
// Playable character builder
// ---------------------------------------------------------------------------

const PLAYABLE_MODE_MAP: Record<string, string> = {
  "animations_gun_1":          "gunslinger_gun1",
  "animations_gun_2":          "gunslinger_gun2",
  "regular_animations":        "sword_master",
  "magic_attacks":             "sword_master_magic",
  "dark_flame_spells":         "dark_flame_spells",
};

function buildPlayableCharacter(issues: ValidationIssue[]): PlayableCharacter {
  const modes: Record<string, PlayableCharacterMode> = {};

  function walkDir(dir: string, modeHint?: string): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir);

    // Check if this directory directly contains PNGs
    const pngs = entries.filter((e) => e.toLowerCase().endsWith(".png"));
    if (pngs.length > 0 && modeHint) {
      const files = pngs.map((f) => path.join(dir, f));
      const modeKey = PLAYABLE_MODE_MAP[modeHint] ?? modeHint.toLowerCase().replace(/\s+/g, "_");
      const sc = buildStandardCharacter(`playable_character/${modeKey}`, dir, files, issues);
      modes[modeKey] = { ...sc, mode: modeKey };
      return;
    }

    // Also handle sprite sheet files in the direct playable dir
    const sheetFiles = entries
      .filter((e) => e.toLowerCase().endsWith(".png") && e.toLowerCase().includes("sheet"))
      .map((e) => path.join(dir, e));
    if (sheetFiles.length > 0) {
      const modeKey = modeHint ?? "default";
      const sc = buildStandardCharacter(`playable_character/${modeKey}`, dir, sheetFiles, issues);
      modes[modeKey] = { ...sc, mode: modeKey };
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      const sub = path.join(dir, entry);
      if (fs.statSync(sub).isDirectory()) {
        walkDir(sub, PLAYABLE_MODE_MAP[entry] ? entry : (modeHint ?? entry));
      }
    }
  }

  walkDir(PLAYABLE_DIR);

  // Fallback: if no modes found, treat the whole dir as a single mode
  if (Object.keys(modes).length === 0) {
    const allFiles: string[] = [];
    const collectPngs = (d: string) => {
      for (const e of fs.readdirSync(d)) {
        const sub = path.join(d, e);
        if (fs.statSync(sub).isDirectory()) collectPngs(sub);
        else if (e.toLowerCase().endsWith(".png")) allFiles.push(sub);
      }
    };
    collectPngs(PLAYABLE_DIR);
    const sc = buildStandardCharacter("playable_character/default", PLAYABLE_DIR, allFiles, issues);
    modes["default"] = { ...sc, mode: "default" };
  }

  return {
    type: "playable",
    id: "playable_character",
    path: relPath(PLAYABLE_DIR),
    modes,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  fs.mkdirSync(OUT_CHARS_DIR, { recursive: true });

  const issues: ValidationIssue[] = [];
  const characters: Record<string, AnyCharacter> = {};

  // Process each character directory
  const charDirs = fs.readdirSync(CHARS_DIR)
    .map((d) => ({ id: d, dir: path.join(CHARS_DIR, d) }))
    .filter(({ dir }) => fs.statSync(dir).isDirectory());

  for (const { id, dir } of charDirs) {
    console.log(`Processing character: ${id}`);
    const char = buildCharacter(id, dir, issues);
    characters[id] = char;

    // Write per-character JSON
    fs.writeFileSync(
      path.join(OUT_CHARS_DIR, `${id}.json`),
      JSON.stringify(char, null, 2),
      "utf-8",
    );
  }

  // Process playable character
  console.log("Processing playable character…");
  const playableCharacter = buildPlayableCharacter(issues);
  fs.writeFileSync(
    path.join(OUT_DIR, "playable_character.json"),
    JSON.stringify(playableCharacter, null, 2),
    "utf-8",
  );

  // Assemble master registry
  const registry: Registry = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    characters,
    playableCharacter,
    validationIssues: issues,
  };

  fs.writeFileSync(
    path.join(OUT_DIR, "registry.json"),
    JSON.stringify(registry, null, 2),
    "utf-8",
  );

  // Write validation report
  const report: string[] = [
    "DarkSpriteLib – Animation Registry Validation Report",
    `Generated: ${registry.generatedAt}`,
    `Characters processed: ${Object.keys(characters).length}`,
    `Playable character modes: ${Object.keys(playableCharacter.modes).length}`,
    `Total issues: ${issues.length}`,
    "",
    "─".repeat(80),
    "",
  ];

  const errors   = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  if (errors.length > 0) {
    report.push(`ERRORS (${errors.length})`);
    report.push("─".repeat(40));
    for (const e of errors) {
      report.push(`  [ERROR] ${e.characterId}${e.subKey ? `/${e.subKey}` : ""}: ${e.message}`);
      if (e.file) report.push(`          → ${e.file}`);
    }
    report.push("");
  }

  if (warnings.length > 0) {
    report.push(`WARNINGS (${warnings.length})`);
    report.push("─".repeat(40));
    for (const w of warnings) {
      report.push(`  [WARN]  ${w.characterId}${w.subKey ? `/${w.subKey}` : ""}: ${w.message}`);
      if (w.file) report.push(`          → ${w.file}`);
    }
    report.push("");
  }

  if (issues.length === 0) {
    report.push("No issues found.");
  }

  fs.writeFileSync(
    path.join(OUT_DIR, "validation_report.txt"),
    report.join("\n"),
    "utf-8",
  );

  console.log(`\nDone.`);
  console.log(`  registry/registry.json`);
  console.log(`  registry/characters/   (${Object.keys(characters).length} files)`);
  console.log(`  registry/playable_character.json`);
  console.log(`  registry/validation_report.txt`);
  console.log(`  Issues: ${errors.length} errors, ${warnings.length} warnings`);
}

main();
