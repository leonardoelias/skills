#!/usr/bin/env bash
# Installs the skills in this repository into Claude Code.
#
#   ./install.sh                          # all of them, in ~/.claude/skills (symlinks: git pull updates them)
#   ./install.sh merge-gauge              # only the ones named
#   ./install.sh --project ~/src/app      # a copy in ~/src/app/.claude/skills (to commit and use in CI)
#   ./install.sh --uninstall [merge-gauge] [--project ~/src/app]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project=""
uninstall=0
names=()

die() { echo "error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "--project needs a folder"
      [[ -d "$2" ]] || die "folder does not exist: $2"
      project="$(cd "$2" && pwd)"
      shift ;;
    --project=*)
      p="${1#--project=}"
      [[ -d "$p" ]] || die "folder does not exist: $p"
      project="$(cd "$p" && pwd)" ;;
    --uninstall) uninstall=1 ;;
    -h | --help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*) die "unknown option: $1 (see --help)" ;;
    *)
      [[ -f "$here/skills/$1/SKILL.md" ]] || die "unknown skill: $1 (available: $(ls "$here/skills" | tr '\n' ' '))"
      names+=("$1") ;;
  esac
  shift
done

if [[ ${#names[@]} -eq 0 ]]; then
  for d in "$here"/skills/*/; do
    [[ -f "$d/SKILL.md" ]] && names+=("$(basename "$d")")
  done
fi

# It's ours if it's a link to the skill's folder, or a folder holding that skill's SKILL.md.
is_ours() {
  local dest="$1" src="$2" name="$3"
  if [[ -L "$dest" ]]; then
    local target
    target="$(cd "$(dirname "$dest")" && cd "$(readlink "$dest")" 2>/dev/null && pwd -P)" || return 1
    [[ "$target" == "$(cd "$src" && pwd -P)" ]]
  else
    [[ -f "$dest/SKILL.md" && "$(sed -n '2p' "$dest/SKILL.md")" == "name: $name" ]]
  fi
}

for name in "${names[@]}"; do
  src="$here/skills/$name"
  dest="${project:-$HOME}/.claude/skills/$name"

  if [[ $uninstall -eq 1 ]]; then
    if [[ -e "$dest" || -L "$dest" ]]; then
      is_ours "$dest" "$src" "$name" || die "refusing to remove $dest: it is not this $name skill"
      rm -rf "$dest"
      echo "removed $dest"
    else
      echo "nothing to remove at $dest"
    fi
    continue
  fi

  if [[ -f "$src/package.json" ]]; then
    command -v node >/dev/null || die "$name needs Node.js 20.10 or newer"
    node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=10)?0:1)' \
      || die "Node.js $(node -v) is too old; $name needs 20.10 or newer"
  fi
  [[ "$name" != visual-diff ]] || command -v git >/dev/null || die "git not found"

  if [[ -e "$dest" || -L "$dest" ]]; then
    is_ours "$dest" "$src" "$name" || die "refusing to replace $dest: it exists and is not this $name skill"
    rm -rf "$dest"
  fi
  mkdir -p "$(dirname "$dest")"

  if [[ -z "$project" ]]; then
    ln -s "$src" "$dest"
    echo "linked $dest -> $src"
    # A skill with no dependencies needs no npm install.
    if [[ -f "$src/package.json" ]] && grep -q '"dependencies"' "$src/package.json"; then
      (cd "$src" && npm install --no-audit --no-fund --loglevel=error)
    fi
  else
    mkdir -p "$dest"
    (cd "$src" && tar --exclude=node_modules --exclude=test -cf - .) | (cd "$dest" && tar -xf -)
    echo "copied to $dest (commit that folder)"
  fi
done

[[ $uninstall -eq 1 ]] || echo "Done. Start a new Claude Code session."
