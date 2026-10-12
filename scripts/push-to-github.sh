#!/usr/bin/env bash
# Export an MCP-only tree for https://github.com/Willie-Liao/lesson-library
# — no school materials, media, papers, or macOS app bundle.
# Usage: ./scripts/push-to-github.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE="${REMOTE:-https://github.com/Willie-Liao/lesson-library.git}"
TMP="${TMP:-$(mktemp -d)}"
DEST="$TMP/lesson-library-export"
SKELETON="$ROOT/export/skeleton"

echo "Exporting MCP distribution from: $ROOT"
echo "Temp dir: $DEST"

mkdir -p "$DEST"

rsync -a \
  --exclude node_modules --exclude .DS_Store \
  "$ROOT/mcp/" "$DEST/mcp/"

rsync -a \
  --exclude node_modules --exclude .DS_Store \
  "$ROOT/server/" "$DEST/server/"

rsync -a \
  --exclude node_modules --exclude .DS_Store \
  --exclude app.js --exclude app.js.map \
  "$ROOT/web/" "$DEST/web/"

rsync -a \
  --exclude node_modules --exclude .DS_Store \
  "$ROOT/prompts/" "$DEST/prompts/"

for f in \
  dev.ts embed_server.py push-to-github.sh seed.ts skill-facet-map.ts \
  apply-skill-facets.ts migrate-facet-sets.ts \
  calendar-model.test.ts calendar-store.test.ts embed.test.ts gatne.test.ts \
  graph-layout.test.ts graph-model.test.ts llm.test.ts overlay-layout.test.ts \
  set-tree.test.ts sets.test.ts taxonomy.test.ts services.test.ts \
  mcp_supervisor.py mcp-supervisor.test.py; do
  if [[ -f "$ROOT/scripts/$f" ]]; then
    mkdir -p "$DEST/scripts"
    rsync -a "$ROOT/scripts/$f" "$DEST/scripts/"
  fi
done

for f in README.md CHANGELOG.md package.json package-lock.json .npmrc tsconfig.json .env.example LICENSE; do
  if [[ -f "$ROOT/$f" ]]; then
    rsync -a "$ROOT/$f" "$DEST/"
  fi
done

rsync -a "$SKELETON/library/" "$DEST/library/"
mkdir -p "$DEST/.cursor"
rsync -a "$SKELETON/.cursor/mcp.json" "$DEST/.cursor/"

rsync -a --exclude skeleton "$ROOT/export/" "$DEST/export/"
cp "$ROOT/export/github.gitignore" "$DEST/.gitignore"

du -sh "$DEST"

cd "$DEST"
VERSION="$(node -p "require('./package.json').version")"
MSG="Release v${VERSION}: lesson-library MCP distribution."

if [[ ! -d .git ]]; then
  git init
  git branch -M main
fi

git add -A
git commit -m "$MSG" || true

git config http.postBuffer 524288000
git remote remove origin 2>/dev/null || true
git remote add origin "$REMOTE"

echo "Pushing $REMOTE @ v${VERSION} ..."
git tag -f "v${VERSION}"
git push -u origin main --force
git push origin "refs/tags/v${VERSION}" --force

NOTES=""
if [[ -f CHANGELOG.md ]]; then
  NOTES="$(awk '/^## v'"${VERSION}"' /{flag=1; next} flag && /^## v/{exit} flag' CHANGELOG.md)"
fi
if command -v gh >/dev/null 2>&1 && [[ -n "$NOTES" ]]; then
  gh release view "v${VERSION}" --repo Willie-Liao/lesson-library >/dev/null 2>&1 \
    && gh release edit "v${VERSION}" --repo Willie-Liao/lesson-library --notes "$NOTES" \
    || gh release create "v${VERSION}" --repo Willie-Liao/lesson-library --title "v${VERSION}" --notes "$NOTES"
fi

echo "Done: $REMOTE (tag v${VERSION})"
