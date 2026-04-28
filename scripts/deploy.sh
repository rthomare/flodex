#!/usr/bin/env bash
# scripts/deploy.sh — pull the latest main and ship to Fly.io + Vercel.
#
# By default deploys both targets. Pass --fly-only or --vercel-only to scope.
# Pass --skip-pull to deploy whatever is currently checked out (useful when
# you want to verify a branch without merging to main first).
#
# Required tools on PATH:
#   - git
#   - flyctl   (https://fly.io/docs/hands-on/install-flyctl/)
#   - vercel   (npm i -g vercel  OR  bun add -g vercel)
#
# Required auth (already logged in via the respective CLI, OR token in env):
#   FLY_API_TOKEN         — flyctl auth token (alt: `flyctl auth login`)
#   VERCEL_TOKEN          — vercel token      (alt: `vercel login`)
#
# Optional:
#   FLODEX_DEPLOY_BRANCH  — branch to deploy (default: main)
#   FLODEX_DEPLOY_REMOTE  — git remote        (default: origin)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${FLODEX_DEPLOY_BRANCH:-main}"
REMOTE="${FLODEX_DEPLOY_REMOTE:-origin}"

DO_FLY=1
DO_VERCEL=1
DO_PULL=1

usage() {
  cat <<EOF
Usage: ${0##*/} [--fly-only|--vercel-only] [--skip-pull] [--help]

Pulls the latest $BRANCH from $REMOTE and deploys:
  - coordinator (Rust) → Fly.io          (uses fly.toml)
  - dashboard  (Next.js) → Vercel prod   (uses vercel.json)

Options:
  --fly-only      Deploy only the Fly.io coordinator
  --vercel-only   Deploy only the Vercel dashboard
  --skip-pull     Don't fetch/checkout/pull; deploy current working tree
  -h, --help      Show this message

Env overrides:
  FLODEX_DEPLOY_BRANCH=$BRANCH
  FLODEX_DEPLOY_REMOTE=$REMOTE
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --fly-only)    DO_VERCEL=0 ;;
    --vercel-only) DO_FLY=0 ;;
    --skip-pull)   DO_PULL=0 ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; exit 1 ;;
  esac
  shift
done

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

cd "$ROOT"

# --- preflight ---------------------------------------------------------------

[ "$DO_FLY" = 1 ] && ! command -v flyctl >/dev/null 2>&1 && \
  die "flyctl not on PATH. Install: https://fly.io/docs/hands-on/install-flyctl/"

[ "$DO_VERCEL" = 1 ] && ! command -v vercel >/dev/null 2>&1 && \
  die "vercel not on PATH. Install: npm i -g vercel  (or  bun add -g vercel)"

if [ "$DO_PULL" = 1 ]; then
  if [ -n "$(git status --porcelain)" ]; then
    die "working tree is dirty. Commit/stash first, or pass --skip-pull."
  fi
fi

# --- sync to latest $BRANCH --------------------------------------------------

if [ "$DO_PULL" = 1 ]; then
  log "fetching $REMOTE/$BRANCH"
  git fetch "$REMOTE" "$BRANCH"

  CURRENT="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$CURRENT" != "$BRANCH" ]; then
    log "checking out $BRANCH (was on $CURRENT)"
    git checkout "$BRANCH"
  fi

  log "fast-forwarding to $REMOTE/$BRANCH"
  git pull --ff-only "$REMOTE" "$BRANCH"
else
  warn "--skip-pull: deploying current tree ($(git rev-parse --short HEAD))"
fi

SHA="$(git rev-parse --short HEAD)"
log "deploying $SHA"

# --- fly.io: coordinator -----------------------------------------------------

if [ "$DO_FLY" = 1 ]; then
  log "fly deploy (coordinator)"
  if [ -n "${FLY_API_TOKEN:-}" ]; then
    flyctl deploy --remote-only --config "$ROOT/fly.toml"
  else
    flyctl deploy --config "$ROOT/fly.toml"
  fi
  log "fly: deployed"
fi

# --- vercel: dashboard -------------------------------------------------------

if [ "$DO_VERCEL" = 1 ]; then
  log "vercel deploy --prod (dashboard)"
  VERCEL_ARGS=(--prod --yes)
  [ -n "${VERCEL_TOKEN:-}" ]      && VERCEL_ARGS+=(--token "$VERCEL_TOKEN")
  [ -n "${VERCEL_ORG_ID:-}" ]     && VERCEL_ARGS+=(--scope "$VERCEL_ORG_ID")
  vercel "${VERCEL_ARGS[@]}"
  log "vercel: deployed"
fi

log "done ($SHA)"
