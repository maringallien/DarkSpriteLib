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
  BiomeObjects,
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
  VariantCharacter,
} from "./schema.js";

type BuildResult = AnyCharacter | VariantCharacter;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dirname, "..");
const CHARS_DIR = path.join(ROOT, "characters");
const ANIMALS_DIR = path.join(ROOT, "animals");
const PLAYABLE_DIR = path.join(ROOT, "playable_character");
const OUT_DIR = path.join(ROOT, "registry");
const OUT_CHARS_DIR = path.join(OUT_DIR, "characters");
const OUT_ANIMALS_DIR = path.join(OUT_DIR, "animals");
const OUT_OBJECTS_DIR = path.join(OUT_DIR, "objects");

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
      // Only apply character-level anchorX to files that aren't individually overridden.
      const anchorX = (!fileOverride && characterId) ? ANCHOR_X_OVERRIDES[characterId] : undefined;
      result.set(file, {
        sheetWidth: w,
        sheetHeight: h,
        frameWidth: fw,
        frameHeight: fh,
        frameCount: fw > 0 ? Math.round((w / fw) * (h / fh)) : 1,
        ...(anchorX !== undefined && { anchorX }),
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
  evil_crow: {
    "evil_crow-trans_to_dive": "trans_dive",
    "evil_crow-trans_to_fly":  "take_off",
  },
  glitch_samurai: {
    "glitch samurai-glitch out":   "attack1_vanish",
    "glitch samurai-jump glitch":  "attack2_vanish",
    "glitch samurai-jump":         "jump",
    "glitch samurai-slash 1":      "attack4",
    "glitch samurai-slash 2":      "attack3",
  },
  hell_bot_dark: {
    "attack": "attack1",
    "shoot":  "attack2",
  },
  human_crow_keeper: {
    "dash":        "attack_1",
    "jump_attack": "attack2_jump",
    "land_atack":  "attack2_slam",
    "shoot_ball":  "attack3",
  },
  golden_retriever: {
    "dead":                        "dead",
    "eat":                         "sniff",
    "golden-bark":                 "bark",
    "golden-bite":                 "attack1",
    "golden-get_up":               "get_up",
    "golden-idle":                 "idle",
    "golden-lay_down_idle":        "lie",
    "golden-ledge_climb":          "ledge_grab",
    "golden-sit":                  "sit_down",
    "golden-sit_idle":             "sit",
    "golden-sleep":                "sleep",
    "golden-stand":                "sit_up",
    "golden-to_sleep":             "go_sleep",
    "golden-wake_up_transition":   "wake_up",
    "golden-walk":                 "walk",
  },
  evil_sage: {
    "attack":          "attack1",
    "duck":            "attack2",
    "evil_shockwave":  "attack2_vfx",
    "dash":            "dash",
    "idle":            "idle",
    "slide":           "slide",
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
  lord_of_the_flames: {
    "lord_of_the_flames-range_fire_burst": "attack4",
    "range_sprite_with_glow":              "attack4_proj",
  },
  // ── Strange companion color variants (each is its own character entry) ──────
  // All three share the same animation key conventions; only the stem prefix differs.
  strange_companion_black: {
    "strange_companion-idle":             "idle",
    "strange_companion-move":             "walk",
    "strange_companion-jump":             "jump",
    "strange_companion-fall":             "fall",
    "strange_companion-land":             "land",
    "strange_companion-roll":             "roll",
    "strange_companion-sleep":            "sleep",
    "strange_companion-wake_up":          "wake_up",
    "strange_companion-blast_1":          "attack1",
    "strange_companion-blast_2":          "attack2",
    "strange_companion-bark":             "bark",
    "strange_companion-chill":            "chill",
    "strange_companion-sit":              "sit",
    "strange_companion-to_idle":          "to_idle",
    "strange_companion-to_sleep":         "to_sleep",
    "strange_companion-to_roll":          "to_roll",
    "strange_companion-trans_jump_to_fall": "trans_jump_to_fall",
    "strange_companion-trans_to_jump":    "trans_to_jump",
    "strange_companion-roll_end":         "roll_end",
    "eat":                                "eat",
  },
  strange_companion_red: {
    "strange_companion_red-idle":             "idle",
    "strange_companion_red-move":             "walk",
    "strange_companion_red-jump":             "jump",
    "strange_companion_red-fall":             "fall",
    "strange_companion_red-land":             "land",
    "strange_companion_red-roll":             "roll",
    "strange_companion_red-sleep":            "sleep",
    "strange_companion_red-wake_up":          "wake_up",
    "strange_companion_red-blast_1":          "attack1",
    "strange_companion_red-blast_2":          "attack2",
    "strange_companion_red-bark":             "bark",
    "strange_companion_red-chill":            "chill",
    "strange_companion_red-sit":              "sit",
    "strange_companion_red-to_idle":          "to_idle",
    "strange_companion_red-to_sleep":         "to_sleep",
    "strange_companion_red-to_roll":          "to_roll",
    "strange_companion_red-trans_jump_to_fall": "trans_jump_to_fall",
    "strange_companion_red-trans_to_jump":    "trans_to_jump",
    "strange_companion_red-roll_end":         "roll_end",
    "eat":                                    "eat",
  },
  strange_companion_teal: {
    "strange_companion_teal-idle":             "idle",
    "strange_companion_teal-move":             "walk",
    "strange_companion_teal-jump":             "jump",
    "strange_companion_teal-fall":             "fall",
    "strange_companion_teal-land":             "land",
    "strange_companion_teal-roll":             "roll",
    "strange_companion_teal-sleep":            "sleep",
    "strange_companion_teal-wake_up":          "wake_up",
    "strange_companion_teal-blast_1":          "attack1",
    "strange_companion_teal-blast_2":          "attack2",
    "strange_companion_teal-bark":             "bark",
    "strange_companion_teal-chill":            "chill",
    "strange_companion_teal-sit":              "sit",
    "strange_companion_teal-to_idle":          "to_idle",
    "strange_companion_teal-to_sleep":         "to_sleep",
    "strange_companion_teal-to_roll":          "to_roll",
    "strange_companion_teal-trans_jump_to_fall": "trans_jump_to_fall",
    "strange_companion_teal-trans_to_jump":    "trans_to_jump",
    "strange_companion_teal-roll_end":         "roll_end",
    "eat":                                     "eat",
  },
  masks_merchant: {
    "mask_merchants": "idle",
  },
  gem_merchant:        { "gem_merchant":        "idle" },
  gun_merchant:        { "gun_merchant":        "idle" },
  mushroom_merchant:   { "mushroom_merchant":   "idle" },
  mountain_merchant1:  { "mountain_merchant1":  "idle" },
  mountain_merchant2:  { "mountain_merchant2":  "idle" },
  mountain_merchant3:  { "mountain_merchant3":  "idle" },
  shielder: {
    "attack": "attack1",
    "range":  "attack2",
  },
};

// Stems to exclude entirely from a character's animation list.
// Per-character stem → { category, loops } overrides.
// Use when a stem's generic normalization rule has the wrong category or loops value
// after a STEM_KEY_OVERRIDE renames it to a semantically different animation type.
const ANIMATION_META_OVERRIDES: Record<string, Record<string, { category?: string; loops?: boolean }>> = {
  evil_sage: {
    "duck": { category: "attack", loops: false },
  },
  human_crow_keeper: {
    "shoot_ball": { category: "attack", loops: false },
  },
  lord_of_the_flames: {
    "lord_of_the_flames-range_fire_burst": { category: "attack", loops: false },
    "range_sprite_with_glow":              { category: "attack", loops: false },
  },
  // ── Strange companion: blast animations are melee/attack, not ranged ─────────
  // ── to_idle/to_sleep are one-shot transitions (PATTERN_RULES /sleep/ fires ──
  // ── on the full unprefixed stem before EXACT_MAP to_sleep: false is reached) ─
  strange_companion_black: {
    "strange_companion-blast_1":  { category: "attack", loops: false },
    "strange_companion-blast_2":  { category: "attack", loops: false },
    "strange_companion-to_idle":  { loops: false },
    "strange_companion-to_sleep": { loops: false },
  },
  strange_companion_red: {
    "strange_companion_red-blast_1":  { category: "attack", loops: false },
    "strange_companion_red-blast_2":  { category: "attack", loops: false },
    "strange_companion_red-to_idle":  { loops: false },
    "strange_companion_red-to_sleep": { loops: false },
  },
  strange_companion_teal: {
    "strange_companion_teal-blast_1":  { category: "attack", loops: false },
    "strange_companion_teal-blast_2":  { category: "attack", loops: false },
    "strange_companion_teal-to_idle":  { loops: false },
    "strange_companion_teal-to_sleep": { loops: false },
  },
  gem_merchant:        { "gem_merchant":        { category: "ui", loops: true } },
  gun_merchant:        { "gun_merchant":        { category: "ui", loops: true } },
  mushroom_merchant:   { "mushroom_merchant":   { category: "ui", loops: true } },
  mountain_merchant1:  { "mountain_merchant1":  { category: "ui", loops: true } },
  mountain_merchant2:  { "mountain_merchant2":  { category: "ui", loops: true } },
  mountain_merchant3:  { "mountain_merchant3":  { category: "ui", loops: true } },
};

const STEM_EXCLUSIONS: Record<string, Set<string>> = {
  ancient_guardian: new Set(["shield_spritesheet"]),
  archer:           new Set(["vfx_for_special", "special_attack_vanish"]),
  archer_bandit:    new Set(["archer_bandit-fall", "archer_bandit-jump"]),
  bomb_droid:       new Set(["idle"]),
  doberman:         new Set(["dog-ledge_grab", "dog"]),
  evil_crow:        new Set(["evil_crow-attack_explode", "evil_crow-attack_idle", "evil_crow-attack_start"]),
  glitch_samurai:   new Set(["glitch samurai-idle gltich"]),
  golden_retriever:  new Set(["golden-ledge_grab", "golden_sprite_sheet"]),
  human_crow_keeper: new Set(["projectile-idle", "projectile_sprite_sheet"]),
  shielder:          new Set(["projectile", "projectile_blue", "projectile_white_tip"]),
  // Full sprite sheet PNGs coexist with individual animation PNGs in each variant dir.
  // The bare "projectile" file (288×64) is also excluded to avoid a key collision with
  // projectile_32x32-idle.png — both would otherwise resolve to "projectile_idle".
  strange_companion_black: new Set(["strange_companion_sprite_sheet", "projectile"]),
  strange_companion_red:   new Set(["strange_companion_red", "projectile"]),
  strange_companion_teal:  new Set(["strange_companion_teal", "projectile"]),
};

// Override the auto-detected frameWidth for a character (all files share one height group).
// Use when the GCD halving heuristic over- or under-corrects.
// Per-character frameWidth overrides, keyed by character id.
// When a character has only one file at a given height, GCD = full sheet width (1 frame).
// Also used when the halving heuristic over- or under-corrects.
const FRAME_WIDTH_OVERRIDES: Record<string, number> = {
  archer: 174,
  caged_spider: 43,
  glitch_samurai: 210,
  kamikaze_crow: 27,
  human_crow_keeper: 268,
  // Strange companion: raw GCD is 126, but the halving heuristic over-corrects
  // (126/25 = 5.04 > 3.0) and produces 63. The true frame width is 126 — proven
  // by odd frame counts at 126 (roll_end=7, sit=17, trans_to_jump=5).
  strange_companion_black: 252,
  strange_companion_red:   252,
  strange_companion_teal:  252,
};

// Per-character anchorX override (pixels from left edge of one frame).
// Set when the sprite content is not bounding-box centred inside the frame.
// Parsers fall back to frameWidth / 2 when anchorX is absent.
const ANCHOR_X_OVERRIDES: Record<string, number> = {
  // Strange companion: character body consistently sits at x≈55 within the 252px frame
  // (measured across all movement/state animations). Default frameWidth/2 = 126 places
  // the character ~71px too far left.
  strange_companion_black: 55,
  strange_companion_red:   55,
  strange_companion_teal:  55,
};

// Per-file frame dimension overrides (relative path from repo root).
// Use for grid sheets (multiple rows) or isolated files with known dimensions.
const FILE_FRAME_OVERRIDES: Record<string, { frameWidth: number; frameHeight: number }> = {
  "characters/archer_bandit/volley_vfx.png":                    { frameWidth: 74,  frameHeight: 111 },
  "characters/human_crow_keeper/projectile-idle.png":           { frameWidth: 114, frameHeight: 84  },
  "characters/human_crow_keeper/projectile_sprite_sheet.png":   { frameWidth: 114, frameHeight: 84  },
  "characters/evil_sage/evil_shockwave.png":        { frameWidth: 137, frameHeight: 39  },
  "characters/dream_merchant1/genie_merchant.png":  { frameWidth: 90,  frameHeight: 63  },
  "characters/dream_merchant2/magic_merchant.png":  { frameWidth: 65,  frameHeight: 49  },
  "characters/dream_merchant3/time_traveler_npc.png": { frameWidth: 64,  frameHeight: 82 },
  "characters/lord_of_the_flames/range_sprite_with_glow.png": { frameWidth: 49, frameHeight: 28 },
  "characters/masks_merchant/mask_merchants.png": { frameWidth: 81, frameHeight: 60 },
  "characters/gem_merchant/gem_merchant.png":        { frameWidth: 101, frameHeight: 37 },
  "characters/gun_merchant/gun_merchant.png":        { frameWidth: 108, frameHeight: 39 },
  "characters/mushroom_merchant/mushroom_merchant.png": { frameWidth: 111, frameHeight: 53 },
  "characters/mountain_merchant1/mountain_merchant1.png": { frameWidth: 128, frameHeight: 71 },
  "characters/mountain_merchant2/mountain_merchant2.png": { frameWidth: 131, frameHeight: 88 },
  "characters/mountain_merchant3/mountain_merchant3.png": { frameWidth: 116, frameHeight: 61 },

  // ── Simple animals ────────────────────────────────────────────────────────
  // crow: 17 px wide, 21 px tall per row; 3 animations
  "animals/crow/crow_blue/crow_blue_animation1.png": { frameWidth: 17, frameHeight: 21 },
  "animals/crow/crow_blue/crow_blue_animation2.png": { frameWidth: 17, frameHeight: 21 },
  "animals/crow/crow_blue/crow_blue_animation3.png": { frameWidth: 17, frameHeight: 21 },
  "animals/crow/crow_red/crow_red_animation1.png":   { frameWidth: 17, frameHeight: 21 },
  "animals/crow/crow_red/crow_red_animation2.png":   { frameWidth: 17, frameHeight: 21 },
  "animals/crow/crow_red/crow_red_animation3.png":   { frameWidth: 17, frameHeight: 21 },
  // elk: 56 px wide, 35 px tall per row; 4 animations
  "animals/elk/elk_blue/elk_animation1.png":         { frameWidth: 56, frameHeight: 35 },
  "animals/elk/elk_blue/elk_animation2.png":         { frameWidth: 56, frameHeight: 35 },
  "animals/elk/elk_blue/elk_animation3.png":         { frameWidth: 56, frameHeight: 35 },
  "animals/elk/elk_blue/elk_animation4.png":         { frameWidth: 56, frameHeight: 35 },
  "animals/elk/elk_red/elk_red_animation1.png":      { frameWidth: 56, frameHeight: 35 },
  "animals/elk/elk_red/elk_red_animation2.png":      { frameWidth: 56, frameHeight: 35 },
  "animals/elk/elk_red/elk_red_animation3.png":      { frameWidth: 56, frameHeight: 35 },
  "animals/elk/elk_red/elk_red_animation4.png":      { frameWidth: 56, frameHeight: 35 },
  // rat: 24 px wide, 8 px tall per row; 3 animations
  "animals/rat/rat_blue/rat_blue_animation1.png":    { frameWidth: 24, frameHeight: 8 },
  "animals/rat/rat_blue/rat_blue_animation2.png":    { frameWidth: 24, frameHeight: 8 },
  "animals/rat/rat_blue/rat_blue_animation3.png":    { frameWidth: 24, frameHeight: 8 },
  "animals/rat/rat_red/rat_red_animation1.png":      { frameWidth: 24, frameHeight: 8 },
  "animals/rat/rat_red/rat_red_animation2.png":      { frameWidth: 24, frameHeight: 8 },
  "animals/rat/rat_red/rat_red_animation3.png":      { frameWidth: 24, frameHeight: 8 },
  // deer split strips (56 px wide, 54 px tall)
  "animals/deer/deer_blue_animation1.png": { frameWidth: 56, frameHeight: 54 },
  "animals/deer/deer_blue_animation2.png": { frameWidth: 56, frameHeight: 54 },
  "animals/deer/deer_blue_animation3.png": { frameWidth: 56, frameHeight: 54 },
  "animals/deer/deer_blue_animation4.png": { frameWidth: 56, frameHeight: 54 },
  "animals/deer/deer_red_animation1.png":  { frameWidth: 56, frameHeight: 54 },
  "animals/deer/deer_red_animation2.png":  { frameWidth: 56, frameHeight: 54 },
  "animals/deer/deer_red_animation3.png":  { frameWidth: 56, frameHeight: 54 },
  "animals/deer/deer_red_animation4.png":  { frameWidth: 56, frameHeight: 54 },
  // fox split strips (28 px wide, 20 px tall)
  "animals/fox/fox_blue/fox_animation1.png":     { frameWidth: 28, frameHeight: 20 },
  "animals/fox/fox_blue/fox_animation2.png":     { frameWidth: 28, frameHeight: 20 },
  "animals/fox/fox_blue/fox_animation3.png":     { frameWidth: 28, frameHeight: 20 },
  "animals/fox/fox_blue/fox_animation4.png":     { frameWidth: 28, frameHeight: 20 },
  "animals/fox/fox_blue/fox_animation5.png":     { frameWidth: 28, frameHeight: 20 },
  "animals/fox/fox_blue/fox_animation6.png":     { frameWidth: 28, frameHeight: 20 },
  "animals/fox/fox_red/fox_red_animation1.png":  { frameWidth: 28, frameHeight: 20 },
  "animals/fox/fox_red/fox_red_animation2.png":  { frameWidth: 28, frameHeight: 20 },
  "animals/fox/fox_red/fox_red_animation3.png":  { frameWidth: 28, frameHeight: 20 },
  "animals/fox/fox_red/fox_red_animation4.png":  { frameWidth: 28, frameHeight: 20 },
  "animals/fox/fox_red/fox_red_animation5.png":  { frameWidth: 28, frameHeight: 20 },
  "animals/fox/fox_red/fox_red_animation6.png":  { frameWidth: 28, frameHeight: 20 },
  // orbs split strips (16 px wide, 16 px tall)
  "animals/orbs/orbs_animation1.png":      { frameWidth: 16, frameHeight: 16 },
  "animals/orbs/orbs_animation2.png":      { frameWidth: 16, frameHeight: 16 },
  "animals/orbs/orbs_animation3.png":      { frameWidth: 16, frameHeight: 16 },
  "animals/orbs/orbs_animation4.png":      { frameWidth: 16, frameHeight: 16 },

  // ── Strange companion projectiles ──────────────────────────────────────────
  "animals/a_strange_companion/projectile/projectile_32x32-explode.png": { frameWidth: 64, frameHeight: 64 },
  "animals/a_strange_companion/projectile/projectile_32x32-idle.png":    { frameWidth: 64, frameHeight: 64 },

  // ── Biome animated objects ─────────────────────────────────────────────────
  // ancient_caves
  "ancient_caves/objects/animated_objects/ancient_rock_animations_1.png": { frameWidth: 36,  frameHeight: 33  }, // ~9fr (content-cropped from 360)
  "ancient_caves/objects/animated_objects/ancient_rock_animations_2.png": { frameWidth: 36,  frameHeight: 33  }, // 8fr (cropped to 288px)
  "ancient_caves/objects/animated_objects/ancient_rock_animations_3.png": { frameWidth: 36,  frameHeight: 50  }, // 14fr
  "ancient_caves/objects/animated_objects/smoke_animations_2.png":        { frameWidth: 12,  frameHeight: 36  }, // 8fr (row1)
  "ancient_caves/objects/animated_objects/smoke_animations_3.png":        { frameWidth: 12,  frameHeight: 26  }, // 8fr (padded to 96px)
  "ancient_caves/objects/animated_objects/smoke_animations_4.png":        { frameWidth: 12,  frameHeight: 38  }, // 16fr (row2)
  "ancient_caves/objects/animated_objects/throne_1.png":                  { frameWidth: 96,  frameHeight: 64  }, // 16fr (cropped, row1 of split)
  "ancient_caves/objects/animated_objects/throne_2.png":                  { frameWidth: 96,  frameHeight: 64  }, // 18fr (row2 of split)
  // blood_temple
  "blood_temple/objects/animated_objects/statue.png":                     { frameWidth: 128, frameHeight: 112 }, // 8fr
  // castle_of_bones
  "castle_of_bones/objects/animated_objects/ancient_door.png":            { frameWidth: 64,  frameHeight: 144 }, // 48fr
  "castle_of_bones/objects/animated_objects/candles_1.png":               { frameWidth: 32,  frameHeight: 18  }, // 8fr (row1 of split)
  "castle_of_bones/objects/animated_objects/candles_2.png":               { frameWidth: 32,  frameHeight: 15  }, // 8fr
  "castle_of_bones/objects/animated_objects/candles_3.png":               { frameWidth: 32,  frameHeight: 18  }, // 8fr (row2 of split)
  "castle_of_bones/objects/animated_objects/ember_pit_shrine.png":        { frameWidth: 32,  frameHeight: 33  }, // 10fr (minima at x=31,63,95…)
  "castle_of_bones/objects/animated_objects/lever.png":                   { frameWidth: 32,  frameHeight: 32  }, // 8fr
  "castle_of_bones/objects/animated_objects/torch_1.png":                 { frameWidth: 64,  frameHeight: 64  }, // 10fr
  // somber_city — rearranged vertical → horizontal; frame sizes are exact
  "somber_city/objects/animated_objects/distant_lightning.png":           { frameWidth: 32,  frameHeight: 32  }, // 18fr
  "somber_city/objects/animated_objects/door_fade.png":                   { frameWidth: 262, frameHeight: 121 }, // 20fr (col-alpha period=262)
  "somber_city/objects/animated_objects/door_light_up.png":               { frameWidth: 262, frameHeight: 121 }, // 19fr (col-alpha period=262)
  "somber_city/objects/animated_objects/fire_torch.png":                  { frameWidth: 9,   frameHeight: 17  }, // 10fr (minima at every ~9px)
  "somber_city/objects/animated_objects/large_lightning.png":             { frameWidth: 64,  frameHeight: 48  }, // 18fr
  "somber_city/objects/animated_objects/small_lightning.png":             { frameWidth: 32,  frameHeight: 32  }, // 18fr
  // the_beneath
  "the_beneath/objects/animated_objects/door_open.png":                   { frameWidth: 41,  frameHeight: 48  }, // 15fr
  "the_beneath/objects/animated_objects/flower_glow.png":                 { frameWidth: 16,  frameHeight: 16  }, // 10fr
  "the_beneath/objects/animated_objects/light_with_bugs.png":             { frameWidth: 32,  frameHeight: 37  }, // 10fr
  "the_beneath/objects/animated_objects/portal/idle.png":                 { frameWidth: 21,  frameHeight: 41  }, // 12fr (63 showed 3 at once)
  "the_beneath/objects/animated_objects/portal/warp.png":                 { frameWidth: 21,  frameHeight: 41  }, // 12fr (63 showed 3 at once)
  "the_beneath/objects/animated_objects/save/down.png":                   { frameWidth: 16,  frameHeight: 19  }, // 4fr
  "the_beneath/objects/animated_objects/save/idle.png":                   { frameWidth: 16,  frameHeight: 19  }, // 4fr
  "the_beneath/objects/animated_objects/save/start_up.png":               { frameWidth: 16,  frameHeight: 19  }, // 7fr
  "the_beneath/objects/animated_objects/torch.png":                       { frameWidth: 7,   frameHeight: 37  }, // 8fr
  // the_grotesque_city
  "the_grotesque_city/objects/animated_objects/boss_door.png":            { frameWidth: 61,  frameHeight: 75  }, // 48fr

  // ── General animated objects ──────────────────────────────────────────────
  // custom_fires — rock/stone_blue/stone_purple variants (468x38, 12 frames @ 39px)
  "general/objects/animated_objects/custom_fires/rock_blue_calm.png":      { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/rock_blue_insane.png":    { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/rock_blue_mild.png":      { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/rock_blue_wild.png":      { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/rock_orange_calm.png":    { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/rock_orange_insane.png":  { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/rock_orange_mild.png":    { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/rock_orange_wild.png":    { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/rock_purple_calm.png":    { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/rock_purple_insane.png":  { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/rock_purple_mild.png":    { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/rock_purple_wild.png":    { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/stone_blue_calm.png":     { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/stone_blue_insane.png":   { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/stone_blue_mild.png":     { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/stone_blue_wild.png":     { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/stone_purple_calm.png":   { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/stone_purple_insane.png": { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/stone_purple_mild.png":   { frameWidth: 39, frameHeight: 38 },
  "general/objects/animated_objects/custom_fires/stone_purple_wild.png":   { frameWidth: 39, frameHeight: 38 },
  // animated_trees — blood_tree_1 (1792x128 per row, 16 frames @ 112px)
  "general/objects/animated_objects/animated_trees/blood_tree_1_animation1.png": { frameWidth: 112, frameHeight: 128 },
  "general/objects/animated_objects/animated_trees/blood_tree_1_animation2.png": { frameWidth: 112, frameHeight: 128 },
  "general/objects/animated_objects/animated_trees/blood_tree_1_animation3.png": { frameWidth: 112, frameHeight: 128 },
  "general/objects/animated_objects/animated_trees/blood_tree_1_animation4.png": { frameWidth: 112, frameHeight: 128 },
  // animated_trees — blood_tree_2 (2048x96 per row, 16 frames @ 128px)
  "general/objects/animated_objects/animated_trees/blood_tree_2_animation1.png": { frameWidth: 128, frameHeight: 96 },
  "general/objects/animated_objects/animated_trees/blood_tree_2_animation2.png": { frameWidth: 128, frameHeight: 96 },
  "general/objects/animated_objects/animated_trees/blood_tree_2_animation3.png": { frameWidth: 128, frameHeight: 96 },
  "general/objects/animated_objects/animated_trees/blood_tree_2_animation4.png": { frameWidth: 128, frameHeight: 96 },
  // portals (4536x90 per row, 24 frames @ 189px)
  "general/objects/animated_objects/portals/ancient_tech_portal_animation1.png": { frameWidth: 189, frameHeight: 90 },
  "general/objects/animated_objects/portals/ancient_tech_portal_animation2.png": { frameWidth: 189, frameHeight: 90 },
  "general/objects/animated_objects/portals/ancient_tech_portal_animation3.png": { frameWidth: 189, frameHeight: 90 },
  "general/objects/animated_objects/portals/blood_portal_animation1.png":        { frameWidth: 189, frameHeight: 90 },
  "general/objects/animated_objects/portals/blood_portal_animation2.png":        { frameWidth: 189, frameHeight: 90 },
  "general/objects/animated_objects/portals/blood_portal_animation3.png":        { frameWidth: 189, frameHeight: 90 },
  "general/objects/animated_objects/portals/grassy_portal_animation1.png":       { frameWidth: 189, frameHeight: 90 },
  "general/objects/animated_objects/portals/grassy_portal_animation2.png":       { frameWidth: 189, frameHeight: 90 },
  "general/objects/animated_objects/portals/grassy_portal_animation3.png":       { frameWidth: 189, frameHeight: 90 },
  "general/objects/animated_objects/portals/normal_portal_animation1.png":       { frameWidth: 189, frameHeight: 90 },
  "general/objects/animated_objects/portals/normal_portal_animation2.png":       { frameWidth: 189, frameHeight: 90 },
  "general/objects/animated_objects/portals/normal_portal_animation3.png":       { frameWidth: 189, frameHeight: 90 },
  // shops — blood_shop (415x69, 5 frames @ 83px)
  "general/objects/animated_objects/shops/blood_shop_animation1.png": { frameWidth: 83, frameHeight: 69 },
  // traps — swaying_sword (945x106 per row, 27 frames @ 35px; anim2/3 trimmed to content)
  "general/objects/animated_objects/traps/swaying_sword_animation1.png": { frameWidth: 35, frameHeight: 106 },
  "general/objects/animated_objects/traps/swaying_sword_animation2.png": { frameWidth: 35, frameHeight: 106 },
  "general/objects/animated_objects/traps/swaying_sword_animation3.png": { frameWidth: 35, frameHeight: 106 },
  // traps — sword_slicer (1024x32, 16 frames @ 64px; all rows merged into single animation)
  "general/objects/animated_objects/traps/sword_slicer.png": { frameWidth: 64, frameHeight: 32 },
  // traps — bear_trap (160x38 per row, 5 frames @ 32px)
  "general/objects/animated_objects/traps/bear_trap_animation1.png": { frameWidth: 32, frameHeight: 38 },
  "general/objects/animated_objects/traps/bear_trap_animation2.png": { frameWidth: 32, frameHeight: 38 },
  // traps — single-animation objects with non-obvious frame widths
  "general/objects/animated_objects/traps/shokcer_ejector.png":     { frameWidth: 64, frameHeight: 64 }, // 20fr
  "general/objects/animated_objects/traps/spikes.png":              { frameWidth: 48, frameHeight: 16 }, // 9fr
  "general/objects/animated_objects/traps/spike_ejector.png":       { frameWidth: 16, frameHeight: 64 }, // 18fr
  "general/objects/animated_objects/traps/spike_ejector_small.png": { frameWidth: 16, frameHeight: 64 }, // 18fr
  // traps — smoke_flame_ejector (272x33 after top-crop, 17 frames @ 16px)
  "general/objects/animated_objects/traps/smoke_flame_ejector_blue.png": { frameWidth: 16, frameHeight: 33 },
  "general/objects/animated_objects/traps/smoke_flame_ejector_red.png":  { frameWidth: 16, frameHeight: 33 },
  // sci-fi_chests — chest_1 (700x19, 35 frames @ 20px; GCD heuristic picks 28 from shared h=19 group with chest_2)
  "general/objects/animated_objects/sci-fi_chests/chest_1.1.png": { frameWidth: 20, frameHeight: 19 },
  "general/objects/animated_objects/sci-fi_chests/chest_1.2.png": { frameWidth: 20, frameHeight: 19 },
  "general/objects/animated_objects/sci-fi_chests/chest_1.3.png": { frameWidth: 20, frameHeight: 19 },
  // sci-fi_chests — chests where GCD heuristic fails (single unique height group)
  "general/objects/animated_objects/sci-fi_chests/chest_5.1.png": { frameWidth: 43, frameHeight: 29 }, // 55fr
  "general/objects/animated_objects/sci-fi_chests/chest_5.2.png": { frameWidth: 43, frameHeight: 29 },
  "general/objects/animated_objects/sci-fi_chests/chest_5.3.png": { frameWidth: 43, frameHeight: 29 },
  "general/objects/animated_objects/sci-fi_chests/chest_6.1.png": { frameWidth: 42, frameHeight: 12 }, // 34fr
  "general/objects/animated_objects/sci-fi_chests/chest_6.2.png": { frameWidth: 42, frameHeight: 12 },
  "general/objects/animated_objects/sci-fi_chests/chest_6.3.png": { frameWidth: 42, frameHeight: 12 },
  "general/objects/animated_objects/sci-fi_chests/chest_7.1.png": { frameWidth: 27, frameHeight: 13 }, // 38fr
  "general/objects/animated_objects/sci-fi_chests/chest_7.2.png": { frameWidth: 27, frameHeight: 13 },
  "general/objects/animated_objects/sci-fi_chests/chest_7.3.png": { frameWidth: 27, frameHeight: 13 },
  // shops — flattened to single horizontal strips
  "general/objects/animated_objects/shops/herb_shop.png": { frameWidth: 70,  frameHeight: 52  }, // 25fr (5 rows × 5fr flattened)
  "general/objects/animated_objects/shops/tech_shop.png": { frameWidth: 108, frameHeight: 108 }, // 20fr (4 rows × 5fr flattened)
};

// ---------------------------------------------------------------------------
// Animal files: character id → ordered list of per-animation PNG paths.
// Each file is exactly one animation (animation1, animation2…).
// Files that were originally combined sprite sheets have already been split
// into individual strips by the offline splitting script.
// ---------------------------------------------------------------------------

// Per-animal animation key names, in file order.
// Use null to skip a file (it will be omitted from the output).
const ANIMAL_ANIM_KEYS: Record<string, (string | null)[]> = {
  crow_blue:  ["idle", "fly", "death"],
  crow_red:   ["idle", "fly", "death"],
  deer_blue:  ["walk", "idle", "look_up", "death"],
  deer_red:   ["walk", "idle", "look_up", "death"],
  elk_blue:   ["idle", "look_up", "walk", "death"],
  elk_red:    ["idle", "look_up", "walk", "death"],
  fox_blue:   ["idle", null, "walk", "run", "take_hit", "death"],
  fox_red:    ["idle", null, "walk", "run", "take_hit", "death"],
  rat_blue:   ["idle", "run", "death"],
  rat_red:    ["idle", "run", "death"],
};

const ANIMAL_FILES: Record<string, string[]> = {
  crow_blue: [
    "animals/crow/crow_blue/crow_blue_animation1.png",
    "animals/crow/crow_blue/crow_blue_animation2.png",
    "animals/crow/crow_blue/crow_blue_animation3.png",
  ],
  crow_red: [
    "animals/crow/crow_red/crow_red_animation1.png",
    "animals/crow/crow_red/crow_red_animation2.png",
    "animals/crow/crow_red/crow_red_animation3.png",
  ],
  deer_blue:  [
    "animals/deer/deer_blue_animation1.png",
    "animals/deer/deer_blue_animation2.png",
    "animals/deer/deer_blue_animation3.png",
    "animals/deer/deer_blue_animation4.png",
  ],
  deer_red: [
    "animals/deer/deer_red_animation1.png",
    "animals/deer/deer_red_animation2.png",
    "animals/deer/deer_red_animation3.png",
    "animals/deer/deer_red_animation4.png",
  ],
  elk_blue: [
    "animals/elk/elk_blue/elk_animation1.png",
    "animals/elk/elk_blue/elk_animation2.png",
    "animals/elk/elk_blue/elk_animation3.png",
    "animals/elk/elk_blue/elk_animation4.png",
  ],
  elk_red: [
    "animals/elk/elk_red/elk_red_animation1.png",
    "animals/elk/elk_red/elk_red_animation2.png",
    "animals/elk/elk_red/elk_red_animation3.png",
    "animals/elk/elk_red/elk_red_animation4.png",
  ],
  fox_blue: [
    "animals/fox/fox_blue/fox_animation1.png",
    "animals/fox/fox_blue/fox_animation2.png",
    "animals/fox/fox_blue/fox_animation3.png",
    "animals/fox/fox_blue/fox_animation4.png",
    "animals/fox/fox_blue/fox_animation5.png",
    "animals/fox/fox_blue/fox_animation6.png",
  ],
  fox_red: [
    "animals/fox/fox_red/fox_red_animation1.png",
    "animals/fox/fox_red/fox_red_animation2.png",
    "animals/fox/fox_red/fox_red_animation3.png",
    "animals/fox/fox_red/fox_red_animation4.png",
    "animals/fox/fox_red/fox_red_animation5.png",
    "animals/fox/fox_red/fox_red_animation6.png",
  ],
  rat_blue: [
    "animals/rat/rat_blue/rat_blue_animation1.png",
    "animals/rat/rat_blue/rat_blue_animation2.png",
    "animals/rat/rat_blue/rat_blue_animation3.png",
  ],
  rat_red: [
    "animals/rat/rat_red/rat_red_animation1.png",
    "animals/rat/rat_red/rat_red_animation2.png",
    "animals/rat/rat_red/rat_red_animation3.png",
  ],
};

// Strange companion: 3 color variants added as separate StandardCharacter entries
// in the characters registry (not the animals registry).
const STRANGE_COMPANION_VARIANTS: Record<string, string> = {
  strange_companion_black: "animals/a_strange_companion/strange_companion_black",
  strange_companion_red:   "animals/a_strange_companion/strange_companion_red",
  strange_companion_teal:  "animals/a_strange_companion/strange_companion_teal",
};
const STRANGE_COMPANION_PROJECTILE_DIR = "animals/a_strange_companion/projectile";

// ---------------------------------------------------------------------------
// Core: build a StandardCharacter from a flat list of PNG files
// ---------------------------------------------------------------------------

interface BuildOptions {
  /**
   * When true, projectile files are always emitted as separate SimpleAnimation
   * entries (projectile_idle, projectile_explode…) and never merged into an
   * AnimationWithProjectile.  Use for companion animals where projectiles are
   * independent entities, not extensions of a ranged attack.
   */
  separateProjectiles?: boolean;
}

function buildStandardCharacter(
  id: string,
  dirPath: string,
  files: string[],
  issues: ValidationIssue[],
  options: BuildOptions = {},
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

    const metaOverride = ANIMATION_META_OVERRIDES[id]?.[stem];
    animations[normalizedKey] = {
      type: "simple",
      key: normalizedKey,
      file: relPath(file),
      category: (metaOverride?.category ?? rule.category) as SimpleAnimation["category"],
      loops: metaOverride?.loops ?? rule.loops,
      frames,
      originalName: stem,
    } satisfies SimpleAnimation;
  }

  // ── 3. Handle projectile files ─────────────────────────────────────────────
  const activeProjectileFiles = projectileFiles.filter(
    (f) => !STEM_EXCLUSIONS[id]?.has(stemOf(f)),
  );
  if (activeProjectileFiles.length > 0) {
    if (options.separateProjectiles) {
      // Always emit projectiles as independent SimpleAnimation entries.
      for (const file of activeProjectileFiles) {
        const stem = stemOf(file);
        const { frames, ambiguous } = getFrames(file);
        if (ambiguous) issues.push({ characterId: id, severity: "warning", message: `Ambiguous frame size for projectile "${stem}"`, file: relPath(file) });
        const key = `projectile_${projectilePartKey(stem)}`;
        animations[key] = {
          type: "simple", key, file: relPath(file),
          category: "ranged", loops: stem.includes("idle"), frames, originalName: stem,
        } satisfies SimpleAnimation;
      }
    } else {
      // Default: link projectiles to the nearest ranged/attack animation.
      const rangedKey = Object.keys(animations).find((k) => k.startsWith("ranged"))
        ?? Object.keys(animations).find((k) => (animations[k] as SimpleAnimation).category === "ranged")
        ?? Object.keys(animations).find((k) => k.startsWith("attack"));

      const projectileStates: ProjectileState[] = activeProjectileFiles.map((file) => {
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
): BuildResult {
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
// Animal character builder
//
// Builds a StandardCharacter from an ordered list of per-animation PNG files.
// Each file becomes animation1, animation2, … in order.
// ---------------------------------------------------------------------------

function buildAnimalCharacter(
  id: string,
  relFilePaths: string[],   // ordered list of paths relative to repo root
  issues: ValidationIssue[],
): StandardCharacter {
  const absFiles = relFilePaths.map((f) => path.join(ROOT, f));
  const frameMap = precomputeFrameData(absFiles, id);
  const animations: Record<string, AnyAnimation> = {};

  const keyNames = ANIMAL_ANIM_KEYS[id];

  for (let i = 0; i < relFilePaths.length; i++) {
    const relFilePath = relFilePaths[i];
    const absFile = absFiles[i];
    // null key means this file is intentionally excluded
    const rawKey = keyNames ? keyNames[i] : `animation${i + 1}`;
    if (rawKey === null) continue;
    const key = rawKey ?? `animation${i + 1}`;

    const raw = frameMap.get(absFile);

    if (!raw) {
      issues.push({ characterId: id, severity: "error", message: `Failed to read PNG dimensions for ${key}`, file: relFilePath });
      continue;
    }

    const { ambiguous, ...frames } = raw;
    if (ambiguous) {
      issues.push({
        characterId: id, severity: "warning",
        message: `Ambiguous frame size for ${key} — verify FILE_FRAME_OVERRIDES entry`,
        file: relFilePath,
      });
    }

    animations[key] = {
      type: "simple",
      key,
      file: relFilePath,
      category: "movement",
      loops: true,
      frames,
      originalName: path.basename(relFilePath, path.extname(relFilePath)),
    } satisfies SimpleAnimation;
  }

  return {
    type: "standard",
    id,
    path: path.dirname(relFilePaths[0]),
    animations,
  };
}

// ---------------------------------------------------------------------------
// Biome animated object builder
// ---------------------------------------------------------------------------

/**
 * Build a StandardCharacter for one animated object group (one or more files).
 * animKeys maps each file (in order) to an animation key.
 */
function buildObjectGroup(
  id: string,
  dirPath: string,
  relFilePaths: string[],
  animKeys: string[],
  issues: ValidationIssue[],
): StandardCharacter {
  const absFiles = relFilePaths.map((f) => path.join(ROOT, f));
  const frameMap = precomputeFrameData(absFiles);
  const animations: Record<string, AnyAnimation> = {};

  for (let i = 0; i < relFilePaths.length; i++) {
    const relFilePath = relFilePaths[i];
    const absFile = absFiles[i];
    const key = animKeys[i];

    const raw = frameMap.get(absFile);
    if (!raw) {
      issues.push({ characterId: id, severity: "error", message: `Failed to read PNG dimensions for animation "${key}"`, file: relFilePath });
      continue;
    }

    const { ambiguous, ...frames } = raw;
    if (ambiguous) {
      issues.push({ characterId: id, severity: "warning", message: `Ambiguous frame size for "${key}" — add FILE_FRAME_OVERRIDES entry`, file: relFilePath });
    }

    animations[key] = {
      type: "simple",
      key,
      file: relFilePath,
      category: "movement",
      loops: true,
      frames,
      originalName: path.basename(relFilePath, path.extname(relFilePath)),
    } satisfies SimpleAnimation;
  }

  return { type: "standard", id, path: dirPath, animations };
}

/**
 * Scan a biome's animated_objects directory and build a BiomeObjects entry.
 *
 * Grouping rules:
 *   - Subdirectories → one object per subdir; each file → one animation (keyed by stem)
 *   - Files matching {stem}_{N}.png with multiple siblings → one object per stem;
 *     animations keyed animation1, animation2, …
 *   - Remaining single-file objects → id = stem, single animation keyed "idle"
 */
function buildBiomeObjects(
  biome: string,
  dir: string,
  issues: ValidationIssue[],
): BiomeObjects {
  const objects: Record<string, StandardCharacter> = {};
  const entries = fs.readdirSync(dir);
  const dirRelPath = relPath(dir);

  // ── Subdirectory groups ───────────────────────────────────────────────────
  const subdirs = entries.filter((e) => fs.statSync(path.join(dir, e)).isDirectory());
  for (const subdir of subdirs) {
    const subdirPath = path.join(dir, subdir);
    const files = listPngs(subdirPath).sort();
    if (files.length === 0) continue;
    const animKeys = files.map((f) => path.basename(f, path.extname(f)));
    const relFiles = files.map((f) => relPath(f));
    objects[subdir] = buildObjectGroup(
      `${biome}/${subdir}`, relPath(subdirPath), relFiles, animKeys, issues,
    );
    objects[subdir].id = subdir;
  }

  // ── Flat PNGs: detect split groups ───────────────────────────────────────
  const flatPngs = entries
    .filter((e) => e.toLowerCase().endsWith(".png"))
    .map((e) => path.join(dir, e));

  // Group files by potential split stem ({stem}_{N}.png)
  const stemMap = new Map<string, string[]>();
  const nonSplit: string[] = [];

  for (const f of flatPngs) {
    const base = path.basename(f, path.extname(f));
    const m = base.match(/^(.+)_(\d+)$/);
    if (m) {
      const stem = m[1];
      if (!stemMap.has(stem)) stemMap.set(stem, []);
      stemMap.get(stem)!.push(f);
    } else {
      nonSplit.push(f);
    }
  }

  // Files with multiple numeric siblings → split group; singletons → standalone
  for (const [stem, files] of stemMap) {
    if (files.length > 1) {
      files.sort((a, b) => {
        const na = parseInt(path.basename(a, ".png").match(/_(\d+)$/)![1], 10);
        const nb = parseInt(path.basename(b, ".png").match(/_(\d+)$/)![1], 10);
        return na - nb;
      });
      const animKeys = files.map((_, i) => `animation${i + 1}`);
      const relFiles = files.map((f) => relPath(f));
      objects[stem] = buildObjectGroup(
        `${biome}/${stem}`, dirRelPath, relFiles, animKeys, issues,
      );
      objects[stem].id = stem;
    } else {
      nonSplit.push(files[0]);
    }
  }

  // ── Standalone single-file objects → animation key "idle" ────────────────
  for (const f of nonSplit) {
    const id = path.basename(f, path.extname(f));
    const relF = relPath(f);
    objects[id] = buildObjectGroup(
      `${biome}/${id}`, dirRelPath, [relF], ["idle"], issues,
    );
    objects[id].id = id;
  }

  return { biome, path: dirRelPath, objects };
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
  fs.mkdirSync(OUT_ANIMALS_DIR, { recursive: true });
  fs.mkdirSync(OUT_OBJECTS_DIR, { recursive: true });

  const issues: ValidationIssue[] = [];
  const characters: Record<string, AnyCharacter> = {};

  // Process each character directory
  const charDirs = fs.readdirSync(CHARS_DIR)
    .map((d) => ({ id: d, dir: path.join(CHARS_DIR, d) }))
    .filter(({ dir }) => fs.statSync(dir).isDirectory());

  for (const { id, dir } of charDirs) {
    console.log(`Processing character: ${id}`);
    const char = buildCharacter(id, dir, issues);

    if (char.type === "variant") {
      // Flatten each variant directly into characters as its own StandardCharacter
      for (const [varKey, variant] of Object.entries(char.variants)) {
        const flatId = `${id}_${varKey}`;
        const flatChar: StandardCharacter = { ...variant, id: flatId, path: char.path };
        characters[flatId] = flatChar;
        fs.writeFileSync(
          path.join(OUT_CHARS_DIR, `${flatId}.json`),
          JSON.stringify(flatChar, null, 2),
          "utf-8",
        );
      }
      // Remove stale top-level JSON if it exists from a previous run
      const staleFile = path.join(OUT_CHARS_DIR, `${id}.json`);
      if (fs.existsSync(staleFile)) fs.unlinkSync(staleFile);
    } else {
      characters[id] = char;
      fs.writeFileSync(
        path.join(OUT_CHARS_DIR, `${id}.json`),
        JSON.stringify(char, null, 2),
        "utf-8",
      );
    }
  }

  // Process strange companion color variants (go into characters, not animals)
  const projectileFiles = listPngs(path.join(ROOT, STRANGE_COMPANION_PROJECTILE_DIR));
  for (const [id, relVariantDir] of Object.entries(STRANGE_COMPANION_VARIANTS)) {
    console.log(`Processing character: ${id}`);
    const varDirPath = path.join(ROOT, relVariantDir);
    const files = listPngs(varDirPath).concat(projectileFiles);
    const char = buildStandardCharacter(id, varDirPath, files, issues, { separateProjectiles: true });
    characters[id] = char;
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

  // Process simple animals (each PNG → one character entry in the animals map)
  const animals: Record<string, AnyCharacter> = {};
  for (const [id, relFilePath] of Object.entries(ANIMAL_FILES)) {
    console.log(`Processing animal: ${id}`);
    const animal = buildAnimalCharacter(id, relFilePath, issues);
    animals[id] = animal;
    fs.writeFileSync(
      path.join(OUT_ANIMALS_DIR, `${id}.json`),
      JSON.stringify(animal, null, 2),
      "utf-8",
    );
  }

  // Process biome animated objects
  const objects: Record<string, BiomeObjects> = {};
  const biomesWithObjects = [
    "ancient_caves",
    "blood_temple",
    "castle_of_bones",
    "general",
    "somber_city",
    "the_beneath",
    "the_grotesque_city",
  ];
  for (const biome of biomesWithObjects) {
    const objDir = path.join(ROOT, biome, "objects", "animated_objects");
    if (fs.existsSync(objDir)) {
      console.log(`Processing objects: ${biome}`);
      const bo = buildBiomeObjects(biome, objDir, issues);
      objects[biome] = bo;
      fs.writeFileSync(
        path.join(OUT_OBJECTS_DIR, `${biome}.json`),
        JSON.stringify(bo, null, 2),
        "utf-8",
      );
    }
  }

  // Assemble master registry
  const registry: Registry = {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    characters,
    playableCharacter,
    animals,
    objects,
    validationIssues: issues,
  };

  fs.writeFileSync(
    path.join(OUT_DIR, "registry.json"),
    JSON.stringify(registry, null, 2),
    "utf-8",
  );

  // Write validation report
  const totalObjects = Object.values(objects).reduce((n, bo) => n + Object.keys(bo.objects).length, 0);
  const report: string[] = [
    "DarkSpriteLib – Animation Registry Validation Report",
    `Generated: ${registry.generatedAt}`,
    `Characters processed: ${Object.keys(characters).length}`,
    `Playable character modes: ${Object.keys(playableCharacter.modes).length}`,
    `Animals processed: ${Object.keys(animals).length}`,
    `Biomes with objects: ${Object.keys(objects).length} (${totalObjects} objects total)`,
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
  console.log(`  registry/objects/      (${Object.keys(objects).length} files, ${totalObjects} objects)`);
  console.log(`  registry/playable_character.json`);
  console.log(`  registry/validation_report.txt`);
  console.log(`  Issues: ${errors.length} errors, ${warnings.length} warnings`);
}

main();
