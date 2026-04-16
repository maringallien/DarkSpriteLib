// ─────────────────────────────────────────────────────────────────────────────
// DarkSpriteLib – Phaser Loader Helper
//
// Usage in your Phaser scene's preload():
//
//   import { loadCharacterAnims, loadPlayableCharacter } from "./phaserLoader";
//   import registry from "./registry.json";
//
//   preload() {
//     loadCharacterAnims(this, registry, "archer", { basePath: "assets/sprites" });
//     loadPlayableCharacter(this, registry, "sword_master", { basePath: "assets/sprites" });
//   }
//
// Each animation is loaded as a spritesheet with key "<characterId>_<animKey>".
// Sequence parts are loaded as "<characterId>_<sequenceKey>_<partKey>".
// Projectile states are loaded as "<characterId>_<animKey>_proj_<projKey>".
// ─────────────────────────────────────────────────────────────────────────────

import type {
  AnyAnimation,
  AnimationWithProjectile,
  BiomeObjects,
  FrameData,
  Registry,
  SequenceAnimation,
  SimpleAnimation,
  StandardCharacter,
} from "./schema";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface LoadOptions {
  /**
   * Base path prepended to all file paths from the registry.
   * Should point to the root of DarkSpriteLib assets as served by your game.
   * e.g. "assets/sprites" → assets will be loaded from "assets/sprites/characters/archer/idle.png"
   * Defaults to "" (files resolved relative to index.html).
   */
  basePath?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type PhaserScene = {
  load: {
    spritesheet(key: string, path: string, config: { frameWidth: number; frameHeight: number }): void;
  };
};

function resolveUrl(file: string, basePath: string): string {
  if (!basePath) return file;
  return `${basePath.replace(/\/$/, "")}/${file}`;
}

function frameConfig(frames: FrameData) {
  return { frameWidth: frames.frameWidth, frameHeight: frames.frameHeight };
}

function loadSimple(
  scene: PhaserScene,
  prefix: string,
  anim: SimpleAnimation,
  basePath: string,
): void {
  scene.load.spritesheet(
    `${prefix}_${anim.key}`,
    resolveUrl(anim.file, basePath),
    frameConfig(anim.frames),
  );
}

function loadWithProjectile(
  scene: PhaserScene,
  prefix: string,
  anim: AnimationWithProjectile,
  basePath: string,
): void {
  scene.load.spritesheet(
    `${prefix}_${anim.key}`,
    resolveUrl(anim.file, basePath),
    frameConfig(anim.frames),
  );
  for (const proj of anim.projectile) {
    scene.load.spritesheet(
      `${prefix}_${anim.key}_proj_${proj.key}`,
      resolveUrl(proj.file, basePath),
      frameConfig(proj.frames),
    );
  }
}

function loadSequence(
  scene: PhaserScene,
  prefix: string,
  anim: SequenceAnimation,
  basePath: string,
): void {
  for (const part of anim.parts) {
    scene.load.spritesheet(
      `${prefix}_${anim.key}_${part.key}`,
      resolveUrl(part.file, basePath),
      frameConfig(part.frames),
    );
  }
}

function loadAnimation(
  scene: PhaserScene,
  prefix: string,
  anim: AnyAnimation,
  basePath: string,
): void {
  switch (anim.type) {
    case "simple":           loadSimple(scene, prefix, anim, basePath); return;
    case "with_projectile":  loadWithProjectile(scene, prefix, anim, basePath); return;
    case "sequence":         loadSequence(scene, prefix, anim, basePath); return;
    default: {
      const _exhaustive: never = anim;
      throw new Error(`[DarkSpriteLib] Unknown animation type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

function loadStandardCharacter(
  scene: PhaserScene,
  char: StandardCharacter,
  prefix: string,
  basePath: string,
): void {
  for (const anim of Object.values(char.animations)) {
    loadAnimation(scene, prefix, anim, basePath);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load all spritesheets for a character into the Phaser loader.
 * Call this inside your scene's preload() method.
 *
 * @param scene      The Phaser scene (pass `this`)
 * @param registry   The imported registry JSON
 * @param characterId The character's id as it appears in the registry
 * @param options    Optional base path configuration
 */
export function loadCharacterAnims(
  scene: PhaserScene,
  registry: Registry,
  characterId: string,
  options: LoadOptions = {},
): void {
  const basePath = options.basePath ?? "";
  const char = registry.characters[characterId];
  if (!char) {
    console.warn(`[DarkSpriteLib] Character "${characterId}" not found in registry`);
    return;
  }

  switch (char.type) {
    case "standard":
      loadStandardCharacter(scene, char, characterId, basePath);
      return;
    case "composite":
      for (const [compKey, comp] of Object.entries(char.components)) {
        loadStandardCharacter(scene, comp, `${characterId}_${compKey}`, basePath);
      }
      return;
    case "variant":
      // Loads ALL variants; keys become "<id>_<variant>_<anim>".
      // Use loadCharacterVariant() to load a single variant.
      for (const [varKey, variant] of Object.entries(char.variants)) {
        loadStandardCharacter(scene, variant, `${characterId}_${varKey}`, basePath);
      }
      return;
    default: {
      const _exhaustive: never = char;
      throw new Error(`[DarkSpriteLib] Unknown character type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Load a specific variant of a variant character.
 * e.g. loadCharacterVariant(this, registry, "lord_of_the_poisons", "no_glow")
 */
export function loadCharacterVariant(
  scene: PhaserScene,
  registry: Registry,
  characterId: string,
  variantKey: string,
  options: LoadOptions = {},
): void {
  const basePath = options.basePath ?? "";
  const char = registry.characters[characterId];
  if (!char || char.type !== "variant") {
    console.warn(`[DarkSpriteLib] No variant character "${characterId}" in registry`);
    return;
  }
  const variant = char.variants[variantKey];
  if (!variant) {
    console.warn(`[DarkSpriteLib] Variant "${variantKey}" not found for "${characterId}"`);
    return;
  }
  loadStandardCharacter(scene, variant, `${characterId}_${variantKey}`, basePath);
}

/**
 * Load a specific component of a composite character.
 * e.g. loadCharacterComponent(this, registry, "the_bone_reaper", "hand")
 */
export function loadCharacterComponent(
  scene: PhaserScene,
  registry: Registry,
  characterId: string,
  componentKey: string,
  options: LoadOptions = {},
): void {
  const basePath = options.basePath ?? "";
  const char = registry.characters[characterId];
  if (!char || char.type !== "composite") {
    console.warn(`[DarkSpriteLib] No composite character "${characterId}" in registry`);
    return;
  }
  const comp = char.components[componentKey];
  if (!comp) {
    console.warn(`[DarkSpriteLib] Component "${componentKey}" not found for "${characterId}"`);
    return;
  }
  loadStandardCharacter(scene, comp, `${characterId}_${componentKey}`, basePath);
}

/**
 * Load a specific playable character mode.
 * e.g. loadPlayableCharacter(this, registry, "sword_master")
 */
export function loadPlayableCharacter(
  scene: PhaserScene,
  registry: Registry,
  modeKey: string,
  options: LoadOptions = {},
): void {
  const basePath = options.basePath ?? "";
  const mode = registry.playableCharacter.modes[modeKey];
  if (!mode) {
    console.warn(`[DarkSpriteLib] Playable character mode "${modeKey}" not found in registry`);
    return;
  }
  loadStandardCharacter(scene, mode, `player_${modeKey}`, basePath);
}

/**
 * Load ALL playable character modes at once.
 */
export function loadAllPlayableCharacterModes(
  scene: PhaserScene,
  registry: Registry,
  options: LoadOptions = {},
): void {
  for (const modeKey of Object.keys(registry.playableCharacter.modes)) {
    loadPlayableCharacter(scene, registry, modeKey, options);
  }
}

/**
 * Load all spritesheets for an animal into the Phaser loader.
 * Animals share the AnyCharacter shape, so the same standard/composite/variant
 * logic applies. Spritesheet keys are "<animalId>_<animKey>".
 */
export function loadAnimal(
  scene: PhaserScene,
  registry: Registry,
  animalId: string,
  options: LoadOptions = {},
): void {
  const basePath = options.basePath ?? "";
  const animal = registry.animals[animalId];
  if (!animal) {
    console.warn(`[DarkSpriteLib] Animal "${animalId}" not found in registry`);
    return;
  }

  switch (animal.type) {
    case "standard":
      loadStandardCharacter(scene, animal, animalId, basePath);
      return;
    case "composite":
      for (const [compKey, comp] of Object.entries(animal.components)) {
        loadStandardCharacter(scene, comp, `${animalId}_${compKey}`, basePath);
      }
      return;
    case "variant":
      for (const [varKey, variant] of Object.entries(animal.variants)) {
        loadStandardCharacter(scene, variant, `${animalId}_${varKey}`, basePath);
      }
      return;
    default: {
      const _exhaustive: never = animal;
      throw new Error(`[DarkSpriteLib] Unknown animal type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Load all animated objects for one biome.
 * Spritesheet keys are "<biomeId>_<objectKey>_<animKey>".
 */
export function loadBiomeObjects(
  scene: PhaserScene,
  registry: Registry,
  biomeId: string,
  options: LoadOptions = {},
): void {
  const basePath = options.basePath ?? "";
  const biome: BiomeObjects | undefined = registry.objects[biomeId];
  if (!biome) {
    console.warn(`[DarkSpriteLib] Biome "${biomeId}" not found in registry`);
    return;
  }
  for (const [objKey, obj] of Object.entries(biome.objects)) {
    loadStandardCharacter(scene, obj, `${biomeId}_${objKey}`, basePath);
  }
}

/**
 * Load a single animated object from a biome.
 */
export function loadBiomeObject(
  scene: PhaserScene,
  registry: Registry,
  biomeId: string,
  objectKey: string,
  options: LoadOptions = {},
): void {
  const basePath = options.basePath ?? "";
  const biome = registry.objects[biomeId];
  if (!biome) {
    console.warn(`[DarkSpriteLib] Biome "${biomeId}" not found in registry`);
    return;
  }
  const obj = biome.objects[objectKey];
  if (!obj) {
    console.warn(`[DarkSpriteLib] Object "${objectKey}" not found in biome "${biomeId}"`);
    return;
  }
  loadStandardCharacter(scene, obj, `${biomeId}_${objectKey}`, basePath);
}

// ---------------------------------------------------------------------------
// Spritesheet key utilities
// ---------------------------------------------------------------------------

/**
 * Get the Phaser spritesheet key for an animation.
 * Useful in create() when setting up this.anims.create().
 */
export function animKey(characterId: string, key: string): string {
  return `${characterId}_${key}`;
}

export function sequencePartKey(characterId: string, sequenceKey: string, partKey: string): string {
  return `${characterId}_${sequenceKey}_${partKey}`;
}

export function projectileKey(characterId: string, attackKey: string, projKey: string): string {
  return `${characterId}_${attackKey}_proj_${projKey}`;
}

export function playerAnimKey(modeKey: string, key: string): string {
  return `player_${modeKey}_${key}`;
}
