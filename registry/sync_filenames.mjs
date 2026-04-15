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

function collectJsonFiles() {
  const files = [];
  for (const section of ['characters', 'animals']) {
    const dir = path.join(__dirname, section);
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.json')) files.push(path.join(dir, name));
    }
  }
  const objectsDir = path.join(__dirname, 'objects');
  for (const name of fs.readdirSync(objectsDir)) {
    if (name.endsWith('.json')) files.push(path.join(objectsDir, name));
  }
  files.push(path.join(__dirname, 'playable_character.json'));
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// First pass: collect all (entityId, animDir) pairs so we know which dirs
// are shared between multiple entities.
// ─────────────────────────────────────────────────────────────────────────────

// Returns a Set of absolute directory paths that are used by >1 entity.
function findSharedDirs(allEntities) {
  // Map: absDir -> Set of entityIds
  const dirToEntities = new Map();

  function recordDir(absDir, entityId) {
    if (!dirToEntities.has(absDir)) dirToEntities.set(absDir, new Set());
    dirToEntities.get(absDir).add(entityId);
  }

  function walkAnimations(animations, entityId) {
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
    if (entity.type === 'standard') {
      walkAnimations(entity.animations, entityId);
    } else if (entity.type === 'composite') {
      for (const comp of Object.values(entity.components)) {
        walkAnimations(comp.animations, entityId);
      }
    } else if (entity.type === 'playable') {
      for (const mode of Object.values(entity.modes)) {
        walkAnimations(mode.animations, entityId);
      }
    } else if (entity.biome !== undefined) {
      for (const [objKey, obj] of Object.entries(entity.objects)) {
        walkAnimations(obj.animations, `${entityId}__${objKey}`);
      }
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
// entityId: the id to prefix with when the dir is shared
// sharedDirs: Set of absolute directory paths with multiple entities
// ─────────────────────────────────────────────────────────────────────────────

function desiredFilename(currentFile, animKey, subKey, entityId, sharedDirs) {
  const absDir = path.dirname(absPath(currentFile));
  const isShared = sharedDirs.has(absDir);
  const dir = path.dirname(currentFile);

  let stem;
  if (isShared) {
    stem = subKey ? `${entityId}_${animKey}_${subKey}` : `${entityId}_${animKey}`;
  } else {
    stem = subKey ? `${animKey}_${subKey}` : `${animKey}`;
  }

  return `${dir}/${stem}.png`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract file references from animations, returning rename descriptors
// ─────────────────────────────────────────────────────────────────────────────

function extractRefs(animations, entityId, sharedDirs) {
  const refs = [];

  for (const [animKey, anim] of Object.entries(animations)) {
    if (anim.type === 'simple' || anim.type === 'with_projectile') {
      const desired = desiredFilename(anim.file, animKey, null, entityId, sharedDirs);
      refs.push({ node: anim, field: 'file', currentFile: anim.file, desiredFile: desired });

      if (anim.type === 'with_projectile' && Array.isArray(anim.projectile)) {
        for (const proj of anim.projectile) {
          const desiredProj = desiredFilename(proj.file, animKey, proj.key, entityId, sharedDirs);
          refs.push({ node: proj, field: 'file', currentFile: proj.file, desiredFile: desiredProj });
        }
      }
    } else if (anim.type === 'sequence') {
      for (const part of anim.parts) {
        const desiredPart = desiredFilename(part.file, animKey, part.key, entityId, sharedDirs);
        refs.push({ node: part, field: 'file', currentFile: part.file, desiredFile: desiredPart });
      }
    }
  }

  return refs;
}

function extractEntityRefs(entity, entityId, sharedDirs) {
  const refs = [];

  if (entity.type === 'standard') {
    refs.push(...extractRefs(entity.animations, entityId, sharedDirs));
  } else if (entity.type === 'composite') {
    for (const comp of Object.values(entity.components)) {
      refs.push(...extractRefs(comp.animations, entityId, sharedDirs));
    }
  } else if (entity.type === 'playable') {
    for (const mode of Object.values(entity.modes)) {
      refs.push(...extractRefs(mode.animations, entityId, sharedDirs));
    }
  } else if (entity.biome !== undefined) {
    for (const [objKey, obj] of Object.entries(entity.objects)) {
      refs.push(...extractRefs(obj.animations, objKey, sharedDirs));
    }
  }

  return refs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derive entityId from parsed entity
// ─────────────────────────────────────────────────────────────────────────────

function getEntityId(entity) {
  if (entity.id) return entity.id;
  if (entity.biome) return entity.biome;
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const jsonFiles = collectJsonFiles();

  // Parse all entities
  const allEntities = jsonFiles.map(jsonFilePath => {
    const entity = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
    return { entity, entityId: getEntityId(entity), jsonFilePath };
  });

  // Find dirs shared by multiple entities
  const sharedDirs = findSharedDirs(allEntities);
  if (sharedDirs.size > 0 && VERBOSE) {
    log('\nShared directories (will use entityId prefix for filenames):');
    for (const d of sharedDirs) log(`  ${path.relative(ROOT, d)}`);
    log('');
  }

  // Build rename map and collect node updates
  const renameMap = new Map(); // currentAbs -> desiredAbs
  // Track all refs per json file (using re-parsed nodes from jsonUpdates below)
  const allRefs = []; // { currentFile, desiredFile, node, field, jsonFilePath }

  for (const { entity, entityId, jsonFilePath } of allEntities) {
    const refs = extractEntityRefs(entity, entityId, sharedDirs);
    for (const ref of refs) {
      const currentAbs = absPath(ref.currentFile);
      const desiredAbs = absPath(ref.desiredFile);
      if (currentAbs !== desiredAbs) {
        renameMap.set(currentAbs, desiredAbs);
      }
      allRefs.push({ ...ref, jsonFilePath });
    }
  }

  // ── Collision detection ──────────────────────────────────────────────────
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

  // ── Report / execute renames ──────────────────────────────────────────────
  let renameCount = 0;

  if (renameMap.size === 0) {
    log('All filenames already match registry keys. Nothing to rename.');
  } else {
    log(`\n── Renames (${renameMap.size}) ─────────────────────────────────`);

    // Two-pass rename: current → .tmp → desired
    const tmpMap = new Map();
    for (const [src, dest] of renameMap) {
      if (!fs.existsSync(src)) {
        console.warn(`  WARN: Source file not found, skipping: ${path.relative(ROOT, src)}`);
        renameMap.delete(src);
        continue;
      }
      const tmp = src + '.__sync_tmp__';
      tmpMap.set(src, tmp);
      log(`  ${path.relative(ROOT, src)}`);
      log(`    -> ${path.relative(ROOT, dest)}`);
      if (!DRY_RUN) fs.renameSync(src, tmp);
      renameCount++;
    }
    if (!DRY_RUN) {
      for (const [src, tmp] of tmpMap) {
        const dest = renameMap.get(src);
        if (dest) fs.renameSync(tmp, dest);
      }
    }
  }

  // ── Update JSON file fields ───────────────────────────────────────────────
  // Re-parse all JSON files fresh for mutation
  const jsonUpdates = new Map();
  for (const jsonFilePath of jsonFiles) {
    jsonUpdates.set(jsonFilePath, JSON.parse(fs.readFileSync(jsonFilePath, 'utf8')));
  }

  let jsonChangeCount = 0;
  for (const { entity: freshEntity, entityId, jsonFilePath } of jsonFiles.map(fp => ({
    entity: jsonUpdates.get(fp),
    entityId: getEntityId(jsonUpdates.get(fp)),
    jsonFilePath: fp,
  }))) {
    const refs = extractEntityRefs(freshEntity, entityId, sharedDirs);
    for (const ref of refs) {
      if (ref.node[ref.field] !== ref.desiredFile) {
        ref.node[ref.field] = ref.desiredFile;
        jsonChangeCount++;
      }
    }
  }

  if (jsonChangeCount > 0) {
    log(`\n── JSON updates (${jsonChangeCount} file fields) ──────────────────`);
    if (!DRY_RUN) {
      for (const [jsonFilePath, entity] of jsonUpdates) {
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

  // ── Collect referenced dirs + files (post-rename desired paths) ───────────
  const referencedAbsPaths = new Set();
  const referencedDirs = new Set();

  for (const fp of jsonFiles) {
    const entity = jsonUpdates.get(fp);
    const entityId = getEntityId(entity);
    const refs = extractEntityRefs(entity, entityId, sharedDirs);
    for (const ref of refs) {
      referencedAbsPaths.add(absPath(ref.desiredFile));
      referencedDirs.add(path.dirname(absPath(ref.desiredFile)));
    }
  }

  // ── Delete unreferenced PNGs ──────────────────────────────────────────────
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
  // Exclude them from the deletion list — they'll become desired files after rename.
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
