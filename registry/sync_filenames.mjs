#!/usr/bin/env node
/**
 * sync_filenames.mjs
 *
 * Establishes a 1-1 relationship between registry animation keys and PNG filenames.
 *
 * Naming rules:
 *   If the entity is the SOLE occupant of its directory:
 *     SimpleAnimation / AnimationWithProjectile (main): {animKey}.png
 *     AnimationWithProjectile projectile states:        {animKey}_{projKey}.png
 *     SequenceAnimation parts:                          {seqKey}_{partKey}.png
 *
 *   If MULTIPLE entities share the same directory (e.g. deer_blue + deer_red
 *   both in animals/deer/, multiple objects in one biome dir), prefix with
 *   the entity ID to avoid collisions:
 *     SimpleAnimation:          {entityId}_{animKey}.png
 *     Projectile states:        {entityId}_{animKey}_{projKey}.png
 *     Sequence parts:           {entityId}_{seqKey}_{partKey}.png
 *
 * Any PNG in a registry-referenced directory that is NOT referenced after
 * renaming will be deleted.
 *
 * Usage:
 *   node registry/sync_filenames.mjs [--dry-run] [--verbose]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

if (DRY_RUN) console.log('[DRY RUN] No filesystem changes will be made.\n');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function absPath(relPath) {
  return path.join(ROOT, relPath);
}

function log(...args) { console.log(...args); }
function verbose(...args) { if (VERBOSE) console.log(...args); }

// ─────────────────────────────────────────────────────────────────────────────
// Collect all per-entity JSON source files
// ─────────────────────────────────────────────────────────────────────────────

const ENTITY_DIRS = ['characters', 'animals', 'objects', 'playable_character'];

function collectJsonFiles() {
  const files = [];
  for (const section of ENTITY_DIRS) {
    const dir = path.join(__dirname, section);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.json')) files.push(path.join(dir, name));
    }
  }
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derive entityId from parsed entity. Throws on malformed input so silent
// 'unknown' collisions can't mask bugs.
// ─────────────────────────────────────────────────────────────────────────────

function getEntityId(entity, jsonFilePath) {
  if (typeof entity.id === 'string' && entity.id.length > 0) return entity.id;
  if (typeof entity.biome === 'string' && entity.biome.length > 0) return entity.biome;
  throw new Error(`Cannot derive entity id (missing 'id' and 'biome'): ${path.relative(ROOT, jsonFilePath)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Iterate every (entityId-for-sharing, animations-record) pair an entity contains.
// Used by both findSharedDirs and extractEntityRefs so they stay in sync.
// ─────────────────────────────────────────────────────────────────────────────

function* walkEntity(entity, entityId) {
  if (entity.type === 'standard') {
    yield { animations: entity.animations, animEntityId: entityId };
  } else if (entity.type === 'composite') {
    for (const comp of Object.values(entity.components)) {
      yield { animations: comp.animations, animEntityId: entityId };
    }
  } else if (entity.type === 'variant') {
    for (const variant of Object.values(entity.variants)) {
      yield { animations: variant.animations, animEntityId: entityId };
    }
  } else if (entity.type === 'playable') {
    for (const mode of Object.values(entity.modes)) {
      yield { animations: mode.animations, animEntityId: entityId };
    }
  } else if (entity.biome !== undefined) {
    // Top-level biome wrapper: each object is its own entity for sharing/prefix purposes.
    for (const [objKey, obj] of Object.entries(entity.objects)) {
      yield { animations: obj.animations, animEntityId: objKey };
    }
  } else {
    throw new Error(`Unknown entity shape (id=${entityId}, keys=${Object.keys(entity).join(',')})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Find directories shared by multiple entities (need entity-id prefix).
// ─────────────────────────────────────────────────────────────────────────────

function findSharedDirs(allEntities) {
  const dirToEntities = new Map(); // absDir -> Set<entityId>

  function recordDir(absDir, entityId) {
    if (!dirToEntities.has(absDir)) dirToEntities.set(absDir, new Set());
    dirToEntities.get(absDir).add(entityId);
  }

  function recordAnimations(animations, entityId) {
    for (const anim of Object.values(animations)) {
      if (anim.type === 'simple' || anim.type === 'with_projectile') {
        recordDir(path.dirname(absPath(anim.file)), entityId);
        if (anim.type === 'with_projectile' && Array.isArray(anim.projectile)) {
          for (const proj of anim.projectile) {
            recordDir(path.dirname(absPath(proj.file)), entityId);
          }
        }
      } else if (anim.type === 'sequence') {
        for (const part of anim.parts) {
          recordDir(path.dirname(absPath(part.file)), entityId);
        }
      }
    }
  }

  for (const { entity, entityId } of allEntities) {
    for (const { animations, animEntityId } of walkEntity(entity, entityId)) {
      recordAnimations(animations, animEntityId);
    }
  }

  const sharedDirs = new Set();
  for (const [dir, entities] of dirToEntities) {
    if (entities.size > 1) sharedDirs.add(dir);
  }
  return sharedDirs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compute desired filename for an animation file reference.
// ─────────────────────────────────────────────────────────────────────────────

function desiredFilename(currentFile, animKey, subKey, entityId, sharedDirs) {
  const absDir = path.dirname(absPath(currentFile));
  const isShared = sharedDirs.has(absDir);
  const dir = path.dirname(currentFile);

  // Skip the entityId prefix when it would just duplicate the animKey
  // (common for biome objects where id == sole animation key).
  const needsPrefix = isShared && entityId !== animKey;

  let stem;
  if (needsPrefix) {
    stem = subKey ? `${entityId}_${animKey}_${subKey}` : `${entityId}_${animKey}`;
  } else {
    stem = subKey ? `${animKey}_${subKey}` : `${animKey}`;
  }

  return `${dir}/${stem}.png`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract rename descriptors (one per animation file reference).
// Each ref holds a live pointer to the JSON node so we can mutate-in-place.
// ─────────────────────────────────────────────────────────────────────────────

function extractRefsFromAnimations(animations, entityId, sharedDirs) {
  const refs = [];
  for (const [animKey, anim] of Object.entries(animations)) {
    if (anim.type === 'simple' || anim.type === 'with_projectile') {
      const desired = desiredFilename(anim.file, animKey, null, entityId, sharedDirs);
      refs.push({ node: anim, currentFile: anim.file, desiredFile: desired });

      if (anim.type === 'with_projectile' && Array.isArray(anim.projectile)) {
        for (const proj of anim.projectile) {
          const desiredProj = desiredFilename(proj.file, animKey, proj.key, entityId, sharedDirs);
          refs.push({ node: proj, currentFile: proj.file, desiredFile: desiredProj });
        }
      }
    } else if (anim.type === 'sequence') {
      for (const part of anim.parts) {
        const desiredPart = desiredFilename(part.file, animKey, part.key, entityId, sharedDirs);
        refs.push({ node: part, currentFile: part.file, desiredFile: desiredPart });
      }
    }
  }
  return refs;
}

function extractEntityRefs(entity, entityId, sharedDirs) {
  const refs = [];
  for (const { animations, animEntityId } of walkEntity(entity, entityId)) {
    refs.push(...extractRefsFromAnimations(animations, animEntityId, sharedDirs));
  }
  return refs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const jsonFiles = collectJsonFiles();

  // Single parse of every JSON file. We mutate these objects in place and
  // write them back at the end.
  const allEntities = jsonFiles.map(jsonFilePath => {
    const entity = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
    return { entity, entityId: getEntityId(entity, jsonFilePath), jsonFilePath };
  });

  const sharedDirs = findSharedDirs(allEntities);
  if (sharedDirs.size > 0 && VERBOSE) {
    log('\nShared directories (will use entityId prefix for filenames):');
    for (const d of sharedDirs) log(`  ${path.relative(ROOT, d)}`);
    log('');
  }

  // Build refs once, attached to the live JSON nodes.
  const allRefs = [];
  for (const { entity, entityId, jsonFilePath } of allEntities) {
    for (const ref of extractEntityRefs(entity, entityId, sharedDirs)) {
      allRefs.push({ ...ref, jsonFilePath });
    }
  }

  // ── Build rename map ────────────────────────────────────────────────────
  const renameMap = new Map(); // currentAbs -> desiredAbs
  for (const ref of allRefs) {
    const currentAbs = absPath(ref.currentFile);
    const desiredAbs = absPath(ref.desiredFile);
    if (currentAbs !== desiredAbs) renameMap.set(currentAbs, desiredAbs);
  }

  // ── Drop renames whose source file is missing ───────────────────────────
  for (const src of [...renameMap.keys()]) {
    if (!fs.existsSync(src)) {
      console.warn(`  WARN: Source file not found, skipping: ${path.relative(ROOT, src)}`);
      renameMap.delete(src);
    }
  }

  // ── Collision detection ─────────────────────────────────────────────────
  const targetToSources = new Map();
  for (const [src, dest] of renameMap) {
    if (!targetToSources.has(dest)) targetToSources.set(dest, []);
    targetToSources.get(dest).push(src);
  }
  const collisions = [...targetToSources.entries()].filter(([, srcs]) => srcs.length > 1);
  if (collisions.length > 0) {
    console.error('ERROR: Naming collisions detected — aborting.\n');
    for (const [dest, srcs] of collisions) {
      console.error(`  Target: ${path.relative(ROOT, dest)}`);
      for (const src of srcs) console.error(`    <- ${path.relative(ROOT, src)}`);
    }
    process.exit(1);
  }

  // ── Report / execute renames (two-pass via tmp to avoid swap collisions) ─
  let renameCount = 0;
  if (renameMap.size === 0) {
    log('All filenames already match registry keys. Nothing to rename.');
  } else {
    log(`\n── Renames (${renameMap.size}) ─────────────────────────────────`);
    const TMP_SUFFIX = '.__sync_tmp__';
    for (const [src, dest] of renameMap) {
      log(`  ${path.relative(ROOT, src)}`);
      log(`    -> ${path.relative(ROOT, dest)}`);
      if (!DRY_RUN) fs.renameSync(src, src + TMP_SUFFIX);
      renameCount++;
    }
    if (!DRY_RUN) {
      for (const [src, dest] of renameMap) {
        fs.renameSync(src + TMP_SUFFIX, dest);
      }
    }
  }

  // ── Mutate JSON nodes in place + write back ─────────────────────────────
  let jsonChangeCount = 0;
  const dirtyJsonFiles = new Set();
  for (const ref of allRefs) {
    if (ref.node.file !== ref.desiredFile) {
      ref.node.file = ref.desiredFile;
      jsonChangeCount++;
      dirtyJsonFiles.add(ref.jsonFilePath);
    }
  }

  if (jsonChangeCount > 0) {
    log(`\n── JSON updates (${jsonChangeCount} file fields across ${dirtyJsonFiles.size} files) ──`);
    if (!DRY_RUN) {
      for (const { entity, jsonFilePath } of allEntities) {
        if (!dirtyJsonFiles.has(jsonFilePath)) continue;
        fs.writeFileSync(jsonFilePath, JSON.stringify(entity, null, 2) + '\n');
        verbose(`  Updated: ${path.relative(ROOT, jsonFilePath)}`);
      }
      log('  Registry JSON files updated.');
    } else {
      log('  (skipped in dry-run)');
    }
  } else {
    log('\nAll JSON file fields already match. No JSON changes needed.');
  }

  // ── Collect referenced dirs + files (post-rename desired paths) ─────────
  const referencedAbsPaths = new Set();
  const referencedDirs = new Set();
  for (const ref of allRefs) {
    referencedAbsPaths.add(absPath(ref.desiredFile));
    referencedDirs.add(path.dirname(absPath(ref.desiredFile)));
  }

  // ── Delete unreferenced PNGs ────────────────────────────────────────────
  const toDelete = [];
  for (const dir of referencedDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.png')) continue;
      const abs = path.join(dir, name);
      if (!referencedAbsPaths.has(abs)) toDelete.push(abs);
    }
  }

  // In dry-run, renames haven't happened so renamed sources still appear on disk.
  // Exclude them from the deletion list — they would become desired files after rename.
  const renameSourceSet = new Set(renameMap.keys());
  const trulyUnreferenced = toDelete.filter(abs => !renameSourceSet.has(abs));

  if (trulyUnreferenced.length === 0) {
    log('\nNo unreferenced PNG files to delete.');
  } else {
    log(`\n── Deletions (${trulyUnreferenced.length}) ──────────────────────────────────`);
    for (const abs of trulyUnreferenced) {
      log(`  DELETE: ${path.relative(ROOT, abs)}`);
      if (!DRY_RUN) fs.unlinkSync(abs);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  log('\n────────────────────────────────────────────────────────────');
  log(`Renames:    ${renameCount}${DRY_RUN ? ' (dry-run)' : ''}`);
  log(`JSON edits: ${jsonChangeCount} field(s)${DRY_RUN ? ' (dry-run)' : ''}`);
  log(`Deletions:  ${trulyUnreferenced.length}${DRY_RUN ? ' (dry-run)' : ''}`);
  if (DRY_RUN) log('\nRe-run without --dry-run to apply changes.');
}

main();
