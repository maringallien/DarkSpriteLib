#!/usr/bin/env python3
"""
Rename all files and directories in lib to be Windows-compatible.
- Spaces -> underscores
- & -> and
- Trailing spaces before extensions -> removed
- Trailing spaces in directory names -> removed
- )) typo -> )

Uses git mv to preserve history.
Renames files first, then directories depth-first (deepest first).
"""

import os
import subprocess
import sys


def new_name(name: str, is_dir: bool) -> str:
    """Compute the Windows-compatible version of a name."""
    result = name

    # Fix double closing parenthesis typo
    result = result.replace("))", ")")

    # Replace & with and (with surrounding space handling)
    result = result.replace(" & ", "_and_")
    result = result.replace("& ", "and_")
    result = result.replace(" &", "_and")
    result = result.replace("&", "and")

    if is_dir:
        # Remove trailing spaces from directory names
        result = result.rstrip()
    else:
        # Remove trailing space before extension (e.g. "attack .png" -> "attack.png")
        if "." in result:
            base, ext = result.rsplit(".", 1)
            base = base.rstrip()
            result = f"{base}.{ext}"

    # Replace remaining spaces with underscores
    result = result.replace(" ", "_")

    return result


def git_mv(old_path: str, new_path: str, dry_run: bool) -> bool:
    """Run git mv old_path new_path. Returns True on success."""
    cmd = ["git", "mv", "--", old_path, new_path]
    if dry_run:
        print(f"  git mv {old_path!r} -> {new_path!r}")
        return True
    else:
        result = subprocess.run(cmd, cwd="/home/marin/Documents/lib", capture_output=True, text=True)
        if result.returncode != 0:
            print(f"ERROR: git mv failed for {old_path!r} -> {new_path!r}")
            print(f"  stdout: {result.stdout}")
            print(f"  stderr: {result.stderr}")
            return False
        return True


def collect_renames(root: str):
    """
    Walk the tree and collect (old_path, new_path) pairs.
    Returns (file_renames, dir_renames) where dir_renames is sorted deepest-first.
    """
    file_renames = []
    dir_renames = []

    # os.walk with topdown=False gives us depth-first (leaves before parents)
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        # Skip .git
        if "/.git" in dirpath or dirpath.endswith("/.git"):
            continue

        # Collect file renames
        for fname in filenames:
            n = new_name(fname, is_dir=False)
            if n != fname:
                old = os.path.join(dirpath, fname)
                new = os.path.join(dirpath, n)
                # Make paths relative to root
                old_rel = os.path.relpath(old, root)
                new_rel = os.path.relpath(new, root)
                file_renames.append((old_rel, new_rel))

        # Collect directory renames (but not root itself)
        rel_dir = os.path.relpath(dirpath, root)
        if rel_dir == ".":
            continue
        dir_basename = os.path.basename(dirpath)
        n = new_name(dir_basename, is_dir=True)
        if n != dir_basename:
            parent = os.path.dirname(rel_dir)
            old_rel = rel_dir
            new_rel = os.path.join(parent, n) if parent else n
            dir_renames.append((old_rel, new_rel))

    return file_renames, dir_renames


def main():
    dry_run = "--execute" not in sys.argv
    root = "/home/marin/Documents/lib"

    if dry_run:
        print("=== DRY RUN (pass --execute to apply) ===\n")
    else:
        print("=== EXECUTING RENAMES ===\n")

    file_renames, dir_renames = collect_renames(root)

    print(f"Files to rename: {len(file_renames)}")
    print(f"Directories to rename: {len(dir_renames)}")
    print()

    errors = 0

    # Step 1: Rename files first (leaves)
    print("--- File renames ---")
    for old, new in file_renames:
        if not git_mv(old, new, dry_run):
            errors += 1

    print()

    # Step 2: Rename directories depth-first
    # dir_renames is already in depth-first order (os.walk topdown=False)
    # BUT after renaming a deeper dir, the path of its parent changes.
    # We must recompute paths as we go.
    print("--- Directory renames ---")

    # Build a list of (old_rel, new_rel) and apply path fixups as we rename
    # Since we process deepest first, we track a mapping of old prefix -> new prefix
    prefix_map = {}  # maps old_prefix -> new_prefix (accumulated as we rename)

    def apply_prefix_map(path):
        """Apply accumulated prefix renames to a path."""
        for old_prefix, new_prefix in sorted(prefix_map.items(), key=lambda x: -len(x[0])):
            if path == old_prefix or path.startswith(old_prefix + os.sep):
                return new_prefix + path[len(old_prefix):]
        return path

    for old_rel, new_rel in dir_renames:
        # Apply any prefix remappings from earlier renames
        actual_old = apply_prefix_map(old_rel)
        # new_rel's parent may also have been renamed
        parent = os.path.dirname(new_rel)
        actual_parent = apply_prefix_map(parent)
        actual_new = os.path.join(actual_parent, os.path.basename(new_rel)) if actual_parent else os.path.basename(new_rel)

        if actual_old != actual_new:
            if not git_mv(actual_old, actual_new, dry_run):
                errors += 1
            else:
                # Record this rename for future prefix fixups
                prefix_map[old_rel] = actual_new

    print()
    if errors:
        print(f"COMPLETED WITH {errors} ERRORS")
        sys.exit(1)
    else:
        print(f"Done. {len(file_renames) + len(dir_renames)} renames {'planned' if dry_run else 'applied'}.")
        if dry_run:
            print("\nRun with --execute to apply.")


if __name__ == "__main__":
    main()
