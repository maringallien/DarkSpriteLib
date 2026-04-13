// ─────────────────────────────────────────────────────────────────────────────
// DarkSpriteLib – Animation Registry Schema
// ─────────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Normalized animation categories
// ---------------------------------------------------------------------------

export type AnimationCategory =
  | "movement"   // idle, walk, run, sprint, jog, fall, jump, land, roll, dash, dodge
  | "attack"     // attack1, attack2, attack3…
  | "ranged"     // ranged1, ranged2…  (projectile-launching attacks)
  | "special"    // special1, special2…  (charged, spin, super, boomarang…)
  | "state"      // take_hit, death, sleep, wake, buff, rage, block, summon
  | "traversal"  // ledge_grab, ledge_climb, wall_slide, jetpack_*
  | "ui";        // inventory_*, shoot_start/end (playable-character mode transitions)

// ---------------------------------------------------------------------------
// Frame data (auto-inferred from PNG header dimensions)
// ---------------------------------------------------------------------------

export interface FrameData {
  /** Total width of the sprite sheet in pixels */
  sheetWidth: number;
  /** Total height of the sprite sheet in pixels */
  sheetHeight: number;
  /** Width of a single frame in pixels */
  frameWidth: number;
  /** Height of a single frame in pixels */
  frameHeight: number;
  /** Total number of frames (sheetWidth/frameWidth * sheetHeight/frameHeight) */
  frameCount: number;
  /**
   * Horizontal anchor point (x), in pixels from the left edge of a single frame.
   * Renderers should align this column with the entity's world X position.
   *
   * Set explicitly when the anchor was determined via the pink-pixel workflow
   * (a #f311e7 pixel placed at the intended center of each frame).
   * Omit when the anchor is simply frameWidth / 2 (content was bounding-box
   * centered) — parsers must fall back to frameWidth / 2 when this field is absent.
   */
  anchorX?: number;
  /**
   * Index of the first frame within the sheet (0-based).
   * Used when multiple animations share a single sprite sheet file.
   */
  startFrame?: number;
  /**
   * true when multiple valid frame sizes divide the sheet evenly —
   * human review recommended.
   */
  ambiguous?: boolean;
}

// ---------------------------------------------------------------------------
// Leaf animation entries
// ---------------------------------------------------------------------------

/** A single animation backed by one sprite-sheet PNG. */
export interface SimpleAnimation {
  type: "simple";
  /** Normalized key, e.g. "attack1" */
  key: string;
  /** Path relative to DarkSpriteLib root */
  file: string;
  category: AnimationCategory;
  /** Whether the animation loops indefinitely */
  loops: boolean;
  frames: FrameData;
  /** Original filename stem before normalization */
  originalName: string;
}

/**
 * An attack (melee or ranged) that spawns a separate projectile entity.
 * The projectile itself has its own animation states (idle, explode, etc.).
 */
export interface ProjectileState {
  key: string;
  file: string;
  loops: boolean;
  frames: FrameData;
  originalName: string;
}

export interface AnimationWithProjectile extends Omit<SimpleAnimation, "type"> {
  type: "with_projectile";
  projectile: ProjectileState[];
}

/**
 * A multi-part animation that must be played in sequence
 * (e.g. teleport = vanish → appear → land).
 */
export interface SequencePart {
  key: string;
  file: string;
  loops: boolean;
  frames: FrameData;
  originalName: string;
}

export interface SequenceAnimation {
  type: "sequence";
  /** Normalized key for the whole sequence, e.g. "teleport" */
  key: string;
  category: AnimationCategory;
  /**
   * Parts in playback order.
   * Each part's key is the sub-step name: "vanish", "appear", "land", etc.
   */
  parts: SequencePart[];
}

export type AnyAnimation =
  | SimpleAnimation
  | AnimationWithProjectile
  | SequenceAnimation;

// ---------------------------------------------------------------------------
// Character entry shapes
// ---------------------------------------------------------------------------

/** Standard character: one set of animations, no sub-components. */
export interface StandardCharacter {
  type: "standard";
  id: string;
  /** Path to the character's animation directory, relative to DarkSpriteLib root */
  path: string;
  animations: Record<string, AnyAnimation>;
}

/**
 * Composite character: made of independently animated sub-entities
 * (e.g. the_bone_reaper has hand, head, orb).
 * Each component is itself a StandardCharacter.
 */
export interface CompositeCharacter {
  type: "composite";
  id: string;
  /** Path to the top-level character directory */
  path: string;
  components: Record<string, StandardCharacter>;
}

/**
 * Variant character: the same entity exists in multiple visual variants
 * (e.g. lord_of_the_poisons has no_glow and with_glow).
 * Each variant is itself a StandardCharacter.
 */
export interface VariantCharacter {
  type: "variant";
  id: string;
  /** Path to the top-level character directory */
  path: string;
  variants: Record<string, StandardCharacter>;
}

export type AnyCharacter =
  | StandardCharacter
  | CompositeCharacter;

// ---------------------------------------------------------------------------
// Playable character (mode-based)
// ---------------------------------------------------------------------------

/**
 * The playable character has multiple equipment modes (sword, blaster, cannon)
 * each with its own animation set.  Treated like a VariantCharacter but kept
 * as a first-class entry so Phaser loaders can handle it distinctly.
 */
export interface PlayableCharacterMode extends StandardCharacter {
  /** Human-readable mode label, e.g. "sword_master", "gunslinger_gun1" */
  mode: string;
}

export interface PlayableCharacter {
  type: "playable";
  id: "playable_character";
  path: string;
  modes: Record<string, PlayableCharacterMode>;
}

// ---------------------------------------------------------------------------
// Top-level registry
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  characterId: string;
  /** Component or variant key if applicable */
  subKey?: string;
  severity: "warning" | "error";
  message: string;
  /** Affected file path */
  file?: string;
}

/**
 * A collection of animated objects belonging to one biome.
 * Each object is a StandardCharacter; single-file objects have one animation
 * keyed "idle", split-file groups use "animation1"/"animation2"…, and
 * subdirectory groups use the file stem as the animation key.
 */
export interface BiomeObjects {
  biome: string;
  /** Path to the animated_objects directory, relative to DarkSpriteLib root */
  path: string;
  /** keyed by object id (e.g. "throne", "portal", "candles") */
  objects: Record<string, StandardCharacter>;
}

export interface Registry {
  version: "1.0.0";
  generatedAt: string;
  /** keyed by character id */
  characters: Record<string, AnyCharacter>;
  playableCharacter: PlayableCharacter;
  /**
   * Ambient animals and companions, keyed by id.
   * Simple animals (crow, deer, elk, fox, orbs, rat) have numbered animations
   * (animation1, animation2…) parsed left-to-right from their sprite sheets.
   * The strange_companion_* variants are in `characters` instead.
   */
  animals: Record<string, AnyCharacter>;
  /**
   * Animated environmental objects, keyed by biome id.
   * Each entry groups all animated objects for one biome.
   */
  objects: Record<string, BiomeObjects>;
  /** Issues detected during generation — review these */
  validationIssues: ValidationIssue[];
}
