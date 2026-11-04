#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Sync this Linux fork with upstream, keeping the purged paths deleted.
#
# Conflict policy:
#   - Purged artifacts (deleted in this fork): our deletion wins, always.
#   - Renamed files (vscode_mcp.py -> workspace_mcp.py): resolve by hand.
#     Port upstream changes from vscode_mcp.py into workspace_mcp.py.
#   - Everything else: normal merge.
set -u

PURGED=(
  bridge.exe
  vscode_mcp.exe
  vscode_mcp.spec
  start.bat
  setup-config.ps1
  start-effectcraft.ps1
  MacOS_Start.command
)

if ! git diff-index --quiet HEAD --; then
  echo "ERROR: working tree is dirty. Commit or stash first."
  exit 1
fi

git fetch upstream || exit 1

if ! git merge --no-edit upstream/main; then
  echo "Merge stopped. Resolve conflicts, then re-run this script."
  exit 1
fi

for path in "${PURGED[@]}"; do
  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    git rm -q --force "$path"
    echo "re-purged $path"
  fi
done

if ! git diff-index --quiet HEAD --; then
  git commit -m "chore: re-purge upstream-renamed artifacts"
fi

python3 -m unittest
echo "Sync complete. Run 'bash Linux_Start.sh' as the smoke test."
