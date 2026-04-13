// ─────────────────────────────────────────────────────────────────────────────
// DarkSpriteLib – Normalization Rules
//
// Maps raw filename stems (lowercased, trimmed) to normalized animation keys,
// categories, and loop flags.
//
// Priority order when a stem matches multiple rules:
//   1. Exact match in EXACT_MAP
//   2. First matching entry in PATTERN_RULES (checked top-to-bottom)
//
// Attack/ranged/special ordinals (attack1, attack2…) are assigned later by
// the generator, which groups all "attack"-category files per character and
// numbers them by alphabetical order of their original names.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnimationCategory } from "./schema.js";

export interface NormRule {
  /** Base normalized key (ordinal suffix added later for attack/ranged/special) */
  baseKey: string;
  category: AnimationCategory;
  loops: boolean;
}

// ---------------------------------------------------------------------------
// Sequence grouping rules
//
// When a character has ALL parts listed here for a given sequence key,
// those files are merged into a SequenceAnimation instead of individual entries.
// Parts are listed in playback order.
// ---------------------------------------------------------------------------

export interface SequenceRule {
  /** Normalized key for the whole sequence */
  sequenceKey: string;
  category: AnimationCategory;
  /** Ordered list of raw stem patterns that form the parts of this sequence */
  parts: Array<{ partKey: string; stemPatterns: string[] }>;
}

export const SEQUENCE_RULES: SequenceRule[] = [
  {
    sequenceKey: "teleport",
    category: "special",
    parts: [
      { partKey: "vanish", stemPatterns: ["teleport_vanish", "vanish", "special_attack_vanish"] },
      { partKey: "appear", stemPatterns: ["teleport_appear", "appear", "appear_attack"] },
      { partKey: "land",   stemPatterns: ["teleport_land"] },
    ],
  },
  {
    sequenceKey: "laser",
    category: "ranged",
    parts: [
      { partKey: "prep",  stemPatterns: ["prep_laser", "hand_prep_laser", "head_prep_laser"] },
      { partKey: "loop",  stemPatterns: ["laser_loop", "hand_laser_loop", "head_laser_loop", "laser_attack"] },
      { partKey: "end",   stemPatterns: ["laser_end", "hand_laser_end", "head_laser_end"] },
    ],
  },
  {
    sequenceKey: "jetpack",
    category: "traversal",
    parts: [
      { partKey: "take_off",   stemPatterns: ["jetpack_take_off"] },
      { partKey: "fly",        stemPatterns: ["jetpack_fly"] },
      { partKey: "land",       stemPatterns: ["jetpack_land", "jetpack_come_down"] },
    ],
  },
  {
    sequenceKey: "spin_charge",
    category: "special",
    parts: [
      { partKey: "start", stemPatterns: ["spin_charge"] },
      { partKey: "end",   stemPatterns: ["spin_charge_end", "spin_slam"] },
    ],
  },
  {
    sequenceKey: "shoot",
    category: "ui",
    parts: [
      { partKey: "start", stemPatterns: ["shoot_start", "shoot_prep"] },
      { partKey: "loop",  stemPatterns: ["shoot_loop", "shoot"] },
      { partKey: "end",   stemPatterns: ["shoot_end"] },
    ],
  },
];

// ---------------------------------------------------------------------------
// Projectile stem detection
//
// Any file whose stem matches one of these patterns is treated as a projectile
// state and linked to the nearest ranged/attack animation in the same character.
// ---------------------------------------------------------------------------

export const PROJECTILE_STEM_PATTERNS: string[] = [
  "projectile",
  "projectile-idle",
  "projectile-attack_idle",
  "projectile-attack_start",
  "projectile-attack_explode",
  "projectile-explode",
  "projectile_32x32-idle",
  "projectile_32x32-explode",
  "projectile_blue",
  "projectile_white_tip",
  "projectile_sprite_sheet",
  "range_poison_no_glow",
  "range_poison_with_glow",
];

export function isProjectileStem(stem: string): boolean {
  const s = stem.toLowerCase();
  return PROJECTILE_STEM_PATTERNS.some((p) => s === p || s.startsWith("projectile"));
}

export function projectilePartKey(stem: string): string {
  const s = stem.toLowerCase();
  if (s.includes("explode")) return "explode";
  if (s.includes("start"))   return "start";
  if (s.includes("idle"))    return "idle";
  if (s.includes("blue"))    return "blue";
  if (s.includes("white"))   return "white";
  return "idle";
}

// ---------------------------------------------------------------------------
// Exact stem → rule map
// Covers every specific stem observed across all characters.
// ---------------------------------------------------------------------------

export const EXACT_MAP: Record<string, NormRule> = {
  // ── Movement ────────────────────────────────────────────────────────────
  idle:                      { baseKey: "idle",    category: "movement", loops: true },
  idle_loop:                 { baseKey: "idle",    category: "movement", loops: true },
  static_idle:               { baseKey: "idle",    category: "movement", loops: true },
  walk:                      { baseKey: "walk",    category: "movement", loops: true },
  move:                      { baseKey: "walk",    category: "movement", loops: true },
  run:                       { baseKey: "run",     category: "movement", loops: true },
  run_fast:                  { baseKey: "sprint",  category: "movement", loops: true },
  "run_with_vfx":            { baseKey: "run",     category: "movement", loops: true },
  sprint:                    { baseKey: "sprint",  category: "movement", loops: true },
  jog:                       { baseKey: "jog",     category: "movement", loops: true },
  fall:                      { baseKey: "fall",    category: "movement", loops: false },
  falling:                   { baseKey: "fall",    category: "movement", loops: false },
  falling_extended:          { baseKey: "fall",    category: "movement", loops: true },
  jump:                      { baseKey: "jump",    category: "movement", loops: false },
  start_jump:                { baseKey: "jump",    category: "movement", loops: false },
  double_jump:               { baseKey: "double_jump", category: "movement", loops: false },
  jump_to_fall_trans:        { baseKey: "jump",    category: "movement", loops: false },
  land:                      { baseKey: "land",    category: "movement", loops: false },
  land_with_vfx:             { baseKey: "land",    category: "movement", loops: false },
  roll:                      { baseKey: "roll",    category: "movement", loops: false },
  dash:                      { baseKey: "dash",    category: "movement", loops: false },
  dodge:                     { baseKey: "dodge",   category: "movement", loops: false },
  "move_with_spark":         { baseKey: "walk",    category: "movement", loops: true },

  // ── Standard attacks (melee) ─────────────────────────────────────────────
  attack:                    { baseKey: "attack", category: "attack", loops: false },
  melee_attack:              { baseKey: "attack", category: "attack", loops: false },
  attack_1:                  { baseKey: "attack", category: "attack", loops: false },
  attack_2:                  { baseKey: "attack", category: "attack", loops: false },
  attack_3:                  { baseKey: "attack", category: "attack", loops: false },
  attack1:                   { baseKey: "attack", category: "attack", loops: false },
  attack2:                   { baseKey: "attack", category: "attack", loops: false },
  attack3:                   { baseKey: "attack", category: "attack", loops: false },
  chain_attack:              { baseKey: "attack", category: "attack", loops: false },
  slam:                      { baseKey: "attack", category: "attack", loops: false },
  slam_attack:               { baseKey: "attack", category: "attack", loops: false },
  stomp_attack:              { baseKey: "attack", category: "attack", loops: false },
  heli_slam:                 { baseKey: "attack", category: "attack", loops: false },
  slash_1:                   { baseKey: "attack", category: "attack", loops: false },
  slash_2:                   { baseKey: "attack", category: "attack", loops: false },
  cross_slice:               { baseKey: "attack", category: "attack", loops: false },
  jabs:                      { baseKey: "attack", category: "attack", loops: false },
  jab_repeat:                { baseKey: "attack", category: "attack", loops: false },
  sweep:                     { baseKey: "attack", category: "attack", loops: false },
  sweep_attack:              { baseKey: "attack", category: "attack", loops: false },
  dash_attack:               { baseKey: "attack", category: "attack", loops: false },
  roll_attack:               { baseKey: "attack", category: "attack", loops: false },
  air_attack:                { baseKey: "attack", category: "attack", loops: false },
  jump_attack:               { baseKey: "attack", category: "attack", loops: false },
  jump_spin:                 { baseKey: "attack", category: "attack", loops: false },
  jump_with_spin:            { baseKey: "attack", category: "attack", loops: false },
  land_atack:                { baseKey: "attack", category: "attack", loops: false }, // typo in source
  land_attack:               { baseKey: "attack", category: "attack", loops: false },
  spin_attack:               { baseKey: "attack", category: "attack", loops: false },
  hand_slam:                 { baseKey: "attack", category: "attack", loops: false },
  "hand_slam_+_swipe":       { baseKey: "attack", category: "attack", loops: false },
  "hand_slam_and_swipe":     { baseKey: "attack", category: "attack", loops: false },
  throw:                     { baseKey: "attack", category: "attack", loops: false },
  blind_attack:              { baseKey: "attack", category: "attack", loops: false },
  prep_blind_attack:         { baseKey: "attack", category: "attack", loops: false },
  "body_solo_for_boomarang":  { baseKey: "attack", category: "attack", loops: false },
  boomarang_arms:            { baseKey: "attack", category: "attack", loops: false },
  move_attack:               { baseKey: "attack", category: "attack", loops: false },
  prep_move_attack:          { baseKey: "attack", category: "attack", loops: false },
  stop_moving_from_attack:   { baseKey: "attack", category: "attack", loops: false },
  asp_attack:                { baseKey: "attack", category: "attack", loops: false },
  asp_chain_stab:            { baseKey: "attack", category: "attack", loops: false },
  asp_spear:                 { baseKey: "attack", category: "attack", loops: false },
  turtle_mech_attack:        { baseKey: "attack", category: "attack", loops: false },
  quick_attacks:             { baseKey: "attack", category: "attack", loops: false },
  charge_attack:             { baseKey: "attack", category: "attack", loops: false },
  dodge_charge_attack:       { baseKey: "attack", category: "attack", loops: false },
  "dive_attack":             { baseKey: "attack", category: "attack", loops: false },
  stab_and_spin_throw:       { baseKey: "attack", category: "attack", loops: false },
  "stab_and_spin_throw_vfx": { baseKey: "attack", category: "attack", loops: false },
  jump_slam_attack_vfx:      { baseKey: "attack", category: "attack", loops: false },

  // ── Ranged attacks ──────────────────────────────────────────────────────
  range_attack:              { baseKey: "ranged", category: "ranged", loops: false },
  range:                     { baseKey: "ranged", category: "ranged", loops: false },
  spit_attack:               { baseKey: "ranged", category: "ranged", loops: false },
  beam_attack:               { baseKey: "ranged", category: "ranged", loops: false },
  guardian_blast:            { baseKey: "ranged", category: "ranged", loops: false },
  asp_range_fire_burst:      { baseKey: "ranged", category: "ranged", loops: false },
  range_poison_no_glow:      { baseKey: "ranged", category: "ranged", loops: false },
  range_poison_with_glow:    { baseKey: "ranged", category: "ranged", loops: false },
  shoot:                     { baseKey: "ranged", category: "ranged", loops: false },
  shoot_while_walking:       { baseKey: "ranged", category: "ranged", loops: true },
  turtle_mech_shoot_loop:    { baseKey: "ranged", category: "ranged", loops: true },
  turtle_mech_shoot_prep:    { baseKey: "ranged", category: "ranged", loops: false },

  // ── Special / charged attacks ────────────────────────────────────────────
  special_attack:            { baseKey: "special", category: "special", loops: false },
  super_attack:              { baseKey: "special", category: "special", loops: false },
  teleport_attack:           { baseKey: "special", category: "special", loops: false },
  charge:                    { baseKey: "special", category: "special", loops: false },
  charge_transition_up:      { baseKey: "special", category: "special", loops: false },
  charge_transition_down:    { baseKey: "special", category: "special", loops: false },
  orb_burst_horizontal:      { baseKey: "special", category: "special", loops: false },
  orb_burst_spikes:          { baseKey: "special", category: "special", loops: false },
  "orb-burst_horizontal":    { baseKey: "special", category: "special", loops: false },
  "orb-burst_spikes":        { baseKey: "special", category: "special", loops: false },
  head_action:               { baseKey: "special", category: "special", loops: false },
  head_electric_smoke:       { baseKey: "special", category: "special", loops: false },
  asp_buff:                  { baseKey: "buff",    category: "state",   loops: false },

  // ── State ────────────────────────────────────────────────────────────────
  take_hit:                  { baseKey: "take_hit", category: "state", loops: false },
  hit:                       { baseKey: "take_hit", category: "state", loops: false },
  damaged:                   { baseKey: "take_hit", category: "state", loops: false },
  death:                     { baseKey: "death",    category: "state", loops: false },
  die:                       { baseKey: "death",    category: "state", loops: false },
  dead:                      { baseKey: "death",    category: "state", loops: false },
  deah:                      { baseKey: "death",    category: "state", loops: false }, // typo in source
  asp_death:                 { baseKey: "death",    category: "state", loops: false },
  hand_death:                { baseKey: "death",    category: "state", loops: false },
  head_death:                { baseKey: "death",    category: "state", loops: false },
  sleep:                     { baseKey: "sleep",    category: "state", loops: true  },
  static_sleep:              { baseKey: "sleep",    category: "state", loops: true  },
  wake:                      { baseKey: "wake",     category: "state", loops: false },
  buff:                      { baseKey: "buff",     category: "state", loops: false },
  heal:                      { baseKey: "buff",     category: "state", loops: false },
  rage:                      { baseKey: "rage",     category: "state", loops: false },
  block:                     { baseKey: "block",    category: "state", loops: true  },
  shield:                    { baseKey: "block",    category: "state", loops: true  },
  summon:                    { baseKey: "summon",   category: "state", loops: false },
  head_summon_orbs:          { baseKey: "summon",   category: "state", loops: false },
  "orb-summon":              { baseKey: "summon",   category: "state", loops: false },
  orb_summon:                { baseKey: "summon",   category: "state", loops: false },
  orb_idle:                  { baseKey: "idle",     category: "movement", loops: true },
  "orb-idle":                { baseKey: "idle",     category: "movement", loops: true },
  hand_idle:                 { baseKey: "idle",     category: "movement", loops: true },
  head_idle:                 { baseKey: "idle",     category: "movement", loops: true },
  asp_idle:                  { baseKey: "idle",     category: "movement", loops: true },

  // ── Traversal ────────────────────────────────────────────────────────────
  ledge_grab:                { baseKey: "ledge_grab",   category: "traversal", loops: false },
  ledge_climb:               { baseKey: "ledge_climb",  category: "traversal", loops: false },
  wall_slide:                { baseKey: "wall_slide",   category: "traversal", loops: true  },

  // ── Vanish / appear (standalone, outside teleport sequence) ──────────────
  vanish:                    { baseKey: "vanish",  category: "special", loops: false },
  disappear:                 { baseKey: "vanish",  category: "special", loops: false },
  dissappear:                { baseKey: "vanish",  category: "special", loops: false }, // typo
  appear:                    { baseKey: "appear",  category: "special", loops: false },
  appear_attack:             { baseKey: "appear",  category: "special", loops: false },
  special_attack_vanish:     { baseKey: "vanish",  category: "special", loops: false },
  transition_to_idle:        { baseKey: "idle",    category: "movement", loops: true },
  return_to_idle_from_special: { baseKey: "idle",  category: "movement", loops: true },

  // ── Blood King specific ──────────────────────────────────────────────────
  "the_blood_king-charge":              { baseKey: "special", category: "special", loops: false },
  "the_blood_king-idle":                { baseKey: "idle",    category: "movement", loops: true },
  "the_blood_king-charge_transition_up": { baseKey: "special", category: "special", loops: false },
  "the_blood_king-charge_transition_down": { baseKey: "special", category: "special", loops: false },
  "the_blood_king-jump_slam_attack_vfx": { baseKey: "attack", category: "attack", loops: false },
  "the_blood_king-dodge_charge_attack":  { baseKey: "attack", category: "attack", loops: false },

  // ── Evil crow ────────────────────────────────────────────────────────────
  "evil_crow-dive":          { baseKey: "attack", category: "attack", loops: false },
  "evil_crow-dive_attack":   { baseKey: "attack", category: "attack", loops: false },
  "evil_crow-trans_to_dive": { baseKey: "attack", category: "attack", loops: false },
  "evil_crow-trans_to_fly":  { baseKey: "walk",   category: "movement", loops: true },
  "kami-kaze_crow-dive":     { baseKey: "attack", category: "attack", loops: false },
  "kami-kaze_crow-explode":  { baseKey: "death",  category: "state",   loops: false },

  // ── UI / inventory (playable character modes) ────────────────────────────
  inventory_idle:            { baseKey: "inventory_idle",  category: "ui", loops: true  },
  inventory_start:           { baseKey: "inventory_open",  category: "ui", loops: false },
  inventory_down:            { baseKey: "inventory_close", category: "ui", loops: false },
};

// ---------------------------------------------------------------------------
// Pattern rules (applied when no exact match found)
// Each entry is checked in order; first match wins.
// ---------------------------------------------------------------------------

export interface PatternRule {
  /** Substring or regex to test against the lowercased stem */
  pattern: RegExp | string;
  rule: NormRule;
}

export const PATTERN_RULES: PatternRule[] = [
  // projectile — handled separately, but catch here as fallback
  { pattern: /^projectile/,      rule: { baseKey: "ranged",   category: "ranged",    loops: false } },
  // attack variants
  { pattern: /attack/,           rule: { baseKey: "attack",   category: "attack",    loops: false } },
  { pattern: /slash/,            rule: { baseKey: "attack",   category: "attack",    loops: false } },
  { pattern: /slam/,             rule: { baseKey: "attack",   category: "attack",    loops: false } },
  { pattern: /stab/,             rule: { baseKey: "attack",   category: "attack",    loops: false } },
  { pattern: /strike/,           rule: { baseKey: "attack",   category: "attack",    loops: false } },
  { pattern: /punch/,            rule: { baseKey: "attack",   category: "attack",    loops: false } },
  { pattern: /swing/,            rule: { baseKey: "attack",   category: "attack",    loops: false } },
  { pattern: /shoot/,            rule: { baseKey: "ranged",   category: "ranged",    loops: false } },
  { pattern: /\brange/,           rule: { baseKey: "ranged",   category: "ranged",    loops: false } },
  { pattern: /laser/,            rule: { baseKey: "ranged",   category: "ranged",    loops: false } },
  { pattern: /beam/,             rule: { baseKey: "ranged",   category: "ranged",    loops: false } },
  { pattern: /spit/,             rule: { baseKey: "ranged",   category: "ranged",    loops: false } },
  { pattern: /charge/,           rule: { baseKey: "special",  category: "special",   loops: false } },
  { pattern: /special/,          rule: { baseKey: "special",  category: "special",   loops: false } },
  { pattern: /super/,            rule: { baseKey: "special",  category: "special",   loops: false } },
  { pattern: /spin/,             rule: { baseKey: "special",  category: "special",   loops: false } },
  { pattern: /death|die|dead/,   rule: { baseKey: "death",    category: "state",     loops: false } },
  { pattern: /hit|damage/,       rule: { baseKey: "take_hit", category: "state",     loops: false } },
  { pattern: /idle/,             rule: { baseKey: "idle",     category: "movement",  loops: true  } },
  { pattern: /walk|move/,        rule: { baseKey: "walk",     category: "movement",  loops: true  } },
  { pattern: /run/,              rule: { baseKey: "run",      category: "movement",  loops: true  } },
  { pattern: /fall/,             rule: { baseKey: "fall",     category: "movement",  loops: false } },
  { pattern: /jump/,             rule: { baseKey: "jump",     category: "movement",  loops: false } },
  { pattern: /land/,             rule: { baseKey: "land",     category: "movement",  loops: false } },
  { pattern: /roll/,             rule: { baseKey: "roll",     category: "movement",  loops: false } },
  { pattern: /dash/,             rule: { baseKey: "dash",     category: "movement",  loops: false } },
  { pattern: /dodge/,            rule: { baseKey: "dodge",    category: "movement",  loops: false } },
  { pattern: /vanish|disappear/, rule: { baseKey: "vanish",   category: "special",   loops: false } },
  { pattern: /appear/,           rule: { baseKey: "appear",   category: "special",   loops: false } },
  { pattern: /teleport/,         rule: { baseKey: "special",  category: "special",   loops: false } },
  { pattern: /ledge/,            rule: { baseKey: "ledge_grab", category: "traversal", loops: false } },
  { pattern: /wall/,             rule: { baseKey: "wall_slide", category: "traversal", loops: true  } },
  { pattern: /jetpack/,          rule: { baseKey: "special",  category: "traversal", loops: false } },
  { pattern: /summon/,           rule: { baseKey: "summon",   category: "state",     loops: false } },
  { pattern: /buff|heal/,        rule: { baseKey: "buff",     category: "state",     loops: false } },
  { pattern: /rage/,             rule: { baseKey: "rage",     category: "state",     loops: false } },
  { pattern: /block|shield/,     rule: { baseKey: "block",    category: "state",     loops: true  } },
  { pattern: /sleep/,            rule: { baseKey: "sleep",    category: "state",     loops: true  } },
  { pattern: /wake/,             rule: { baseKey: "wake",     category: "state",     loops: false } },
  { pattern: /inventory/,        rule: { baseKey: "inventory_idle", category: "ui", loops: true  } },
  { pattern: /sprint/,           rule: { baseKey: "sprint",   category: "movement",  loops: true  } },
  { pattern: /jog/,              rule: { baseKey: "jog",      category: "movement",  loops: true  } },
  // Full combined sprite sheets — single file containing all frames; loader must select sub-ranges
  { pattern: /sprite.?sheet|spritesheet/, rule: { baseKey: "full_sheet", category: "ui", loops: false } },
  // Embedded frame-dimension pattern e.g. "glitch samurai 140x46" or "shadow of storms 159x53"
  { pattern: /\d+x\d+/,          rule: { baseKey: "full_sheet", category: "ui", loops: false } },
  // Ambient animal / NPC color variant singles
  { pattern: /_sprite_blue|_sprite_red/, rule: { baseKey: "full_sheet", category: "ui", loops: false } },
  // Simple NPC single-file names (ambient characters with one sheet)
  { pattern: /merchant|\bguard\b|loader|senator|strangler|tamer|watcher|fortune_teller|magic_dude|time_traveler/,
    rule: { baseKey: "full_sheet", category: "ui", loops: false } },
];

// ---------------------------------------------------------------------------
// Additional entries: animals, NPCs, VFX, glitch samurai, misc
// ---------------------------------------------------------------------------

Object.assign(EXACT_MAP, {
  // ── Animal / ambient NPC behaviours ────────────────────────────────────
  fly:                      { baseKey: "walk",    category: "movement", loops: true  },
  bark:                     { baseKey: "idle",    category: "state",    loops: false },
  bite:                     { baseKey: "attack",  category: "attack",   loops: false },
  get_up:                   { baseKey: "wake",    category: "state",    loops: false },
  sit:                      { baseKey: "sleep",   category: "state",    loops: true  },
  stand:                    { baseKey: "idle",    category: "movement", loops: true  },
  duck:                     { baseKey: "idle",    category: "movement", loops: true  },
  eat:                      { baseKey: "idle",    category: "state",    loops: true  },
  chill:                    { baseKey: "idle",    category: "state",    loops: true  },
  slide:                    { baseKey: "dash",    category: "movement", loops: false },
  spawn:                    { baseKey: "appear",  category: "special",  loops: false },
  to_idle:                  { baseKey: "idle",    category: "movement", loops: true  },
  to_sleep:                 { baseKey: "sleep",   category: "state",    loops: false },
  wake_up:                  { baseKey: "wake",    category: "state",    loops: false },
  trans_to_jump:            { baseKey: "jump",    category: "movement", loops: false },
  trans_jump_to_fall:       { baseKey: "fall",    category: "movement", loops: false },
  roll_end:                 { baseKey: "land",    category: "movement", loops: false },

  // ── Companion-specific ─────────────────────────────────────────────────
  blast_1:                  { baseKey: "ranged",  category: "ranged",   loops: false },
  blast_2:                  { baseKey: "ranged",  category: "ranged",   loops: false },
  blast:                    { baseKey: "ranged",  category: "ranged",   loops: false },

  // ── Movement transitions ───────────────────────────────────────────────
  turnaround_to_left:       { baseKey: "walk",    category: "movement", loops: false },
  turnaound_to_right:       { baseKey: "walk",    category: "movement", loops: false }, // typo in source
  start_moving:             { baseKey: "walk",    category: "movement", loops: false },
  stop_moving:              { baseKey: "walk",    category: "movement", loops: false },

  // ── Ability / attack ────────────────────────────────────────────────────
  spear:                    { baseKey: "attack",  category: "attack",   loops: false },
  finisher:                 { baseKey: "special", category: "special",  loops: false },
  tele:                     { baseKey: "special", category: "special",  loops: false }, // short for teleport

  // ── Glitch samurai ─────────────────────────────────────────────────────
  "idle gltich":            { baseKey: "idle",    category: "movement", loops: true  }, // typo: "gltich"
  idle_glitch:              { baseKey: "idle",    category: "movement", loops: true  },
  "jump glitch":            { baseKey: "jump",    category: "movement", loops: false },
  jump_glitch:              { baseKey: "jump",    category: "movement", loops: false },
  "glitch out":             { baseKey: "special", category: "special",  loops: false },
  glitch_out:               { baseKey: "special", category: "special",  loops: false },
  "glitch slices":          { baseKey: "attack",  category: "attack",   loops: false },
  glitch_slices:            { baseKey: "attack",  category: "attack",   loops: false },
  "glitch sweep":           { baseKey: "attack",  category: "attack",   loops: false },
  glitch_sweep:             { baseKey: "attack",  category: "attack",   loops: false },
  "wall sit":               { baseKey: "wall_slide", category: "traversal", loops: true },
  wall_sit:                 { baseKey: "wall_slide", category: "traversal", loops: true },
  "slash 1":                { baseKey: "attack",  category: "attack",   loops: false },
  "slash 2":                { baseKey: "attack",  category: "attack",   loops: false },

  // ── VFX / effects (linked to parent character) ─────────────────────────
  bomb:                     { baseKey: "ranged",  category: "ranged",   loops: false },
  dark_bomb:                { baseKey: "ranged",  category: "ranged",   loops: false },
  dark_circle_of_flames:    { baseKey: "special", category: "special",  loops: false },
  dark_face_bomb:           { baseKey: "ranged",  category: "ranged",   loops: false },
  dark_flame_1:             { baseKey: "special", category: "special",  loops: false },
  dark_flame_2:             { baseKey: "special", category: "special",  loops: false },
  dark_flaming_sword:       { baseKey: "special", category: "special",  loops: false },
  dark_orb:                 { baseKey: "special", category: "special",  loops: false },
  explosion:                { baseKey: "death",   category: "state",    loops: false },
  explode:                  { baseKey: "death",   category: "state",    loops: false },
  evil_shockwave:           { baseKey: "special", category: "special",  loops: false },
  shockwave_vfx:            { baseKey: "special", category: "special",  loops: false },
  volley_vfx:               { baseKey: "ranged",  category: "ranged",   loops: false },
  "weird lamp-like ornament": { baseKey: "idle",  category: "movement", loops: true  },

  // ── Panda protector ─────────────────────────────────────────────────────
  "bazooka_panda-melee":    { baseKey: "attack",  category: "attack",   loops: false },
  "bazooka_panda-shoot":    { baseKey: "ranged",  category: "ranged",   loops: false },
  "bazooka_panda-idle":     { baseKey: "idle",    category: "movement", loops: true  },
  "bazooka_panda-walk":     { baseKey: "walk",    category: "movement", loops: true  },
  "bazooka_panda-hit":      { baseKey: "take_hit",category: "state",    loops: false },
  "bazooka_panda-death":    { baseKey: "death",   category: "state",    loops: false },

  // ── Ancient guardian ────────────────────────────────────────────────────
  "guardian-blast":          { baseKey: "attack",   category: "attack",   loops: false },
  "guardian-tele":           { baseKey: "disappear", category: "special", loops: false },

  // ── Lord of the flames ───────────────────────────────────────────────────
  "lord_of_the_flames-spear": { baseKey: "attack", category: "attack",  loops: false },

  // ── Standalone ambient entity sheets ────────────────────────────────────
  orbs:                     { baseKey: "full_sheet", category: "ui",     loops: false },

  // ── Dog / golden_retriever specific ─────────────────────────────────────
  dog:                      { baseKey: "idle",     category: "movement", loops: true  },
  lay_down_idle:            { baseKey: "sleep",    category: "state",    loops: true  },
  sit_idle:                 { baseKey: "sleep",    category: "state",    loops: true  },
  walk_sniff:               { baseKey: "walk",     category: "movement", loops: true  },
  wake_up_transition:       { baseKey: "wake",     category: "state",    loops: false },
} satisfies Record<string, NormRule>);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Strip a character name prefix from a stem.
 * Handles patterns like "archer_bandit-attack_1" → "attack_1"
 * and "Glitch Samurai-Death" (lowercased to "glitch samurai-death") → "death".
 * The raw stem is lowercased and space-normalized before calling this.
 */
export function stripPrefix(stem: string): string {
  const s = stem.toLowerCase();
  const idx = s.indexOf("-");
  if (idx <= 0) return s;
  // Return the part after the first hyphen.
  // Preserve remaining hyphens so the caller can continue stripping progressively.
  return s.slice(idx + 1);
}

/** Normalize a raw filename stem to a NormRule (or null if unrecognised). */
export function normalize(stem: string): NormRule | null {
  const s = stem.toLowerCase().trim();

  function tryMatch(candidate: string): NormRule | null {
    const exact = EXACT_MAP[candidate];
    if (exact) return exact;
    for (const { pattern, rule } of PATTERN_RULES) {
      if (typeof pattern === "string" ? candidate.includes(pattern) : pattern.test(candidate)) {
        return rule;
      }
    }
    return null;
  }

  // 1. Try full stem
  const full = tryMatch(s);
  if (full) return full;

  // 2. Progressively strip character prefixes (handles "kami-kaze_crow-fly" → "kaze_crow-fly" → "fly")
  let current = s;
  while (current.includes("-")) {
    current = stripPrefix(current);
    const match = tryMatch(current);
    if (match) return match;
  }

  return null;
}

/**
 * Given a list of stems that all resolve to the same baseKey (e.g. "attack"),
 * return them sorted and numbered: attack1, attack2, attack3…
 * Single items remain unnumbered (attack, not attack1).
 */
export function assignOrdinals(
  baseKey: string,
  stems: string[],
): Record<string, string> {
  const sorted = [...stems].sort();
  if (sorted.length === 1) return { [sorted[0]]: baseKey };
  return Object.fromEntries(sorted.map((s, i) => [s, `${baseKey}${i + 1}`]));
}
