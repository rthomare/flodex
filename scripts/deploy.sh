#!/usr/bin/env bash
# scripts/deploy.sh — pull the latest main and ship to Fly.io + Vercel.
#
# By default deploys all three targets (fly + dashboard + marketing). Pass any
# of the *-only flags to scope. Pass --skip-pull to deploy whatever is currently
# checked out (useful when verifying a branch without merging to main first).
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
# Each Vercel project is linked once via `cd apps/<app> && vercel link` (creates
# apps/<app>/.vercel/). After that, `vercel --prod` from that folder targets the
# right project.
#
# Optional:
#   FLDX_DEPLOY_BRANCH  — branch to deploy (default: main)
#   FLDX_DEPLOY_REMOTE  — git remote        (default: origin)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${FLDX_DEPLOY_BRANCH:-main}"
REMOTE="${FLDX_DEPLOY_REMOTE:-origin}"

DO_FLY=1
DO_DASHBOARD=1
DO_MARKETING=1
DO_PULL=1

usage() {
  cat <<EOF
Usage: ${0##*/} [target-flag]... [--skip-pull] [--help]

Pulls the latest $BRANCH from $REMOTE and deploys:
  - coordinator (Rust) → Fly.io           (uses fly.toml)
  - dashboard  (Next.js) → Vercel prod    (apps/dashboard/vercel.json)
  - marketing  (Next.js) → Vercel prod    (apps/marketing/vercel.json)

Target flags (any combination; default is all three):
  --fly-only         Only the Fly.io coordinator
  --vercel-only      Both Vercel apps (dashboard + marketing)
  --dashboard-only   Only the dashboard
  --marketing-only   Only the marketing site

Other:
  --skip-pull        Don't fetch/checkout/pull; deploy current working tree
  -h, --help         Show this message

Env overrides:
  FLDX_DEPLOY_BRANCH=$BRANCH
  FLDX_DEPLOY_REMOTE=$REMOTE
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --fly-only)        DO_DASHBOARD=0; DO_MARKETING=0 ;;
    --vercel-only)     DO_FLY=0 ;;
    --dashboard-only)  DO_FLY=0; DO_MARKETING=0 ;;
    --marketing-only)  DO_FLY=0; DO_DASHBOARD=0 ;;
    --skip-pull)       DO_PULL=0 ;;
    -h|--help)         usage; exit 0 ;;
    *)                 usage >&2; exit 1 ;;
  esac
  shift
done

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

cd "$ROOT"

# --- preflight ---------------------------------------------------------------

NEED_VERCEL=0
[ "$DO_DASHBOARD" = 1 ] && NEED_VERCEL=1
[ "$DO_MARKETING" = 1 ] && NEED_VERCEL=1

[ "$DO_FLY" = 1 ] && ! command -v flyctl >/dev/null 2>&1 && \
  die "flyctl not on PATH. Install: https://fly.io/docs/hands-on/install-flyctl/"

[ "$NEED_VERCEL" = 1 ] && ! command -v vercel >/dev/null 2>&1 && \
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

# --- vercel ------------------------------------------------------------------

# Deploy a single Vercel app from its own folder. The folder must already be
# linked (`vercel link`) or have VERCEL_PROJECT_ID set in the environment.
deploy_vercel_app() {
  local label="$1"; local dir="$2"
  log "vercel deploy --prod ($label)"
  local args=(--prod --yes)
  [ -n "${VERCEL_TOKEN:-}" ]  && args+=(--token "$VERCEL_TOKEN")
  [ -n "${VERCEL_ORG_ID:-}" ] && args+=(--scope "$VERCEL_ORG_ID")
  ( cd "$ROOT/$dir" && vercel "${args[@]}" )
  log "vercel: $label deployed"
}

if [ "$DO_DASHBOARD" = 1 ]; then
  deploy_vercel_app dashboard apps/dashboard
fi

if [ "$DO_MARKETING" = 1 ]; then
  deploy_vercel_app marketing apps/marketing
fi

log "done ($SHA)"
