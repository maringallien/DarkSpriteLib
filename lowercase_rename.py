#!/usr/bin/env python3
"""
Lowercase all file and directory names in lib.
- Uses git mv for tracked items
- Uses plain mv + git add for untracked items
- Renames files first, then directories depth-first (deepest first)
- Skips .git and .claude directories
"""

import os
import subprocess
import sys

ROOT = "/home/marin/Documents/lib"
DRY_RUN = "--execute" not in sys.argv

SKIP_DIRS = {".git", ".claude"}


def skip_path(path):
    parts = path.replace(ROOT + "/", "").split(os.sep)
    return any(p in SKIP_DIRS for p in parts)


def git_mv(old_rel, new_rel):
    r = subprocess.run(
        ["git", "mv", "--", old_rel, new_rel],
        capture_output=True, text=True, cwd=ROOT
    )
    return r.returncode == 0, r.stderr.strip()


def plain_mv(old_abs, new_abs):
    try:
        os.rename(old_abs, new_abs)
        return True, ""
    except OSError as e:
        return False, str(e)


def collect():
    """Walk depth-first and collect (old_rel, new_rel) for files and dirs."""
    file_renames = []
    dir_renames = []  # will be sorted deepest-first

    for dirpath, dirnames, filenames in os.walk(ROOT, topdown=False):
        # Prune skip dirs in-place
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        if skip_path(dirpath):
            continue

        rel_dir = os.path.relpath(dirpath, ROOT)

        # Files
        for fname in filenames:
            lower = fname.lower()
            if lower != fname:
                old_rel = os.path.join(rel_dir, fname) if rel_dir != "." else fname
                new_rel = os.path.join(rel_dir, lower) if rel_dir != "." else lower
                file_renames.append((old_rel, new_rel))

        # Directories (skip root itself)
        if rel_dir == ".":
            continue
        base = os.path.basename(dirpath)
        lower = base.lower()
        if lower != base:
            parent = os.path.dirname(rel_dir)
            new_rel = os.path.join(parent, lower) if parent else lower
            dir_renames.append((rel_dir, new_rel))

    return file_renames, dir_renames


def is_tracked(rel_path):
    r = subprocess.run(
        ["git", "ls-files", "--error-unmatch", rel_path],
        capture_output=True, text=True, cwd=ROOT
    )
    return r.returncode == 0


def main():
    if DRY_RUN:
        print("=== DRY RUN (pass --execute to apply) ===\n")
    else:
        print("=== EXECUTING RENAMES ===\n")

    file_renames, dir_renames = collect()
    print(f"Files to lowercase: {len(file_renames)}")
    print(f"Directories to lowercase: {len(dir_renames)}")
    print()

    errors = 0
    prefix_map = {}  # old_rel -> new_rel for dirs already renamed

    def apply_prefixes(path):
        for old, new in sorted(prefix_map.items(), key=lambda x: -len(x[0])):
            if path == old or path.startswith(old + os.sep):
                return new + path[len(old):]
        return path

    # --- Files ---
    print("--- Files ---")
    for old_rel, new_rel in file_renames:
        actual_old = apply_prefixes(old_rel)
        actual_new = apply_prefixes(new_rel)
        if DRY_RUN:
            print(f"  {actual_old!r} -> {os.path.basename(actual_new)!r}")
            continue
        ok, err = git_mv(actual_old, actual_new)
        if not ok:
            # Fallback: plain mv + stage
            old_abs = os.path.join(ROOT, actual_old)
            new_abs = os.path.join(ROOT, actual_new)
            ok2, err2 = plain_mv(old_abs, new_abs)
            if ok2:
                subprocess.run(["git", "add", actual_new], cwd=ROOT, capture_output=True)
                subprocess.run(["git", "rm", "--cached", "--ignore-unmatch", actual_old],
                               cwd=ROOT, capture_output=True)
                print(f"  mv+add: {os.path.basename(actual_old)} -> {os.path.basename(actual_new)}")
            else:
                print(f"  ERROR: {actual_old}: git={err} mv={err2}")
                errors += 1

    # --- Directories ---
    print("\n--- Directories ---")
    for old_rel, new_rel in dir_renames:
        actual_old = apply_prefixes(old_rel)
        parent = os.path.dirname(new_rel)
        actual_parent = apply_prefixes(parent)
        actual_new = os.path.join(actual_parent, os.path.basename(new_rel)) if actual_parent else os.path.basename(new_rel)

        if actual_old == actual_new:
            continue

        if DRY_RUN:
            print(f"  {actual_old!r} -> {os.path.basename(actual_new)!r}")
            prefix_map[old_rel] = actual_new
            continue

        ok, err = git_mv(actual_old, actual_new)
        if not ok:
            old_abs = os.path.join(ROOT, actual_old)
            new_abs = os.path.join(ROOT, actual_new)
            ok2, err2 = plain_mv(old_abs, new_abs)
            if ok2:
                subprocess.run(["git", "add", "-A", actual_new], cwd=ROOT, capture_output=True)
                subprocess.run(["git", "rm", "-r", "--cached", "--ignore-unmatch", actual_old],
                               cwd=ROOT, capture_output=True)
                print(f"  mv+add: {os.path.basename(actual_old)} -> {os.path.basename(actual_new)}")
                prefix_map[old_rel] = actual_new
            else:
                print(f"  ERROR: {actual_old}: git={err} mv={err2}")
                errors += 1
        else:
            prefix_map[old_rel] = actual_new

    print()
    if errors:
        print(f"COMPLETED WITH {errors} ERRORS")
        sys.exit(1)
    else:
        total = len(file_renames) + len(dir_renames)
        print(f"Done. {total} renames {'planned' if DRY_RUN else 'applied'}.")
        if DRY_RUN:
            print("Run with --execute to apply.")


if __name__ == "__main__":
    main()
