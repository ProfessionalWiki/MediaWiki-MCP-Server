#!/usr/bin/env bash
#
# provision-dev-wiki.sh — register an OAuth 2.0 consumer (and optional bot
# password) on a MediaWiki container running Extension:OAuth, for local
# end-to-end testing of the hosted OAuth proxy.
#
# The environment — a running MediaWiki container with Extension:OAuth and
# OAuth2 enabled — is the caller's responsibility. This script only provisions
# credentials against a container that already exists.
#
# Usage:  scripts/provision-dev-wiki.sh <container> [options]
#
# Credential lines print to STDOUT in env-file format; capture them with:
#   set -a; eval "$( scripts/provision-dev-wiki.sh <container> )"; set +a
# All human-readable progress goes to STDERR, keeping STDOUT clean.

set -euo pipefail

# --- defaults ---------------------------------------------------------------
PUBLIC_URL='http://localhost:3000/mcp'
WIKI_URL='http://localhost:8080'
MW_PATH='/var/www/html'
ADMIN_USER='Admin'
GRANTS='basic,highvolume,editpage,editprotected,createeditmovepage,delete,uploadfile,uploadeditmovefile'
WITH_BOT=1
DRY_RUN=0
CONTAINER=''

log() { printf '%s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
	cat <<'EOF'
provision-dev-wiki.sh — register an OAuth 2.0 consumer (+ optional bot password)
on a MediaWiki container running Extension:OAuth, for local OAuth-proxy testing.

Usage: scripts/provision-dev-wiki.sh <container> [options]

  <container>          Docker container name or id running MediaWiki (required).

Options:
  --public-url <url>   Proxy public base (MCP_PUBLIC_URL). Default: http://localhost:3000/mcp
                       Consumer callback is derived as <public-url>/oauth/callback.
  --wiki-url <url>     Browser/API base of the wiki. Default: http://localhost:8080
  --mw-path <path>     MediaWiki install path inside the container. Default: /var/www/html
  --admin-user <name>  Wiki account that owns the consumer/bot password. Default: Admin
  --grants <csv>       Comma-separated grant ids. Default covers every write tool.
  --no-bot             Skip bot-password creation.
  --dry-run            Print the docker commands that would run, then exit.
  -h, --help           Show this help.

Output (stdout, env-file format): OAUTH2_CLIENT_ID, MW_DEV_BOT_USER,
MW_DEV_BOT_PASSWORD, and (for loopback wikis) MCP_TRUSTED_HOSTS.
EOF
}

# --- parse args -------------------------------------------------------------
while [ $# -gt 0 ]; do
	case "$1" in
		--public-url) PUBLIC_URL="${2:?--public-url needs a value}"; shift 2 ;;
		--wiki-url)   WIKI_URL="${2:?--wiki-url needs a value}"; shift 2 ;;
		--mw-path)    MW_PATH="${2:?--mw-path needs a value}"; shift 2 ;;
		--admin-user) ADMIN_USER="${2:?--admin-user needs a value}"; shift 2 ;;
		--grants)     GRANTS="${2:?--grants needs a value}"; shift 2 ;;
		--no-bot)     WITH_BOT=0; shift ;;
		--bot)        WITH_BOT=1; shift ;;
		--dry-run)    DRY_RUN=1; shift ;;
		-h|--help)    usage; exit 0 ;;
		-*)           usage >&2; die "unknown option: $1" ;;
		*)            if [ -z "$CONTAINER" ]; then CONTAINER="$1"; else die "unexpected argument: $1"; fi; shift ;;
	esac
done

[ -n "$CONTAINER" ] || { usage >&2; die "missing <container> argument"; }

CALLBACK_URL="${PUBLIC_URL%/}/oauth/callback"
CONSUMER_NAME="MCP dev proxy (${PUBLIC_URL})"
RUN_PHP="${MW_PATH%/}/maintenance/run.php"
OAUTH_SCRIPT="${MW_PATH%/}/extensions/OAuth/maintenance/createOAuthConsumer.php"

# --- assemble commands as arrays (safe quoting for both run and print) ------
consumer_argv=(docker exec "$CONTAINER" php "$RUN_PHP" "$OAUTH_SCRIPT"
	--user "$ADMIN_USER" --name "$CONSUMER_NAME"
	--description 'MediaWiki MCP Server dev proxy' --version '1.0'
	--oauthVersion 2 --oauth2IsNotConfidential
	--oauth2GrantTypes authorization_code --oauth2GrantTypes refresh_token
	--callbackUrl "$CALLBACK_URL" --approve --jsonOnSuccess)
IFS=',' read -ra grant_arr <<< "$GRANTS"
for g in "${grant_arr[@]}"; do consumer_argv+=(--grants "$g"); done

botpw_argv=(docker exec "$CONTAINER" php "$RUN_PHP" createBotPassword
	--appid mcp-dev --grants "$GRANTS" "$ADMIN_USER")

# --- dry-run: print the commands and exit (no Docker contact) ---------------
if [ "$DRY_RUN" -eq 1 ]; then
	printf '%q ' "${consumer_argv[@]}"; printf '\n'
	if [ "$WITH_BOT" -eq 1 ]; then printf '%q ' "${botpw_argv[@]}"; printf '\n'; fi
	exit 0
fi

# --- preflight --------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)"
[ "$running" = "true" ] || die "container '$CONTAINER' is not running"
docker exec "$CONTAINER" test -f "$RUN_PHP" \
	|| die "MediaWiki not found at $MW_PATH in '$CONTAINER' (set --mw-path)"
docker exec "$CONTAINER" test -f "$OAUTH_SCRIPT" \
	|| die "Extension:OAuth not found at $MW_PATH/extensions/OAuth (install it and enable OAuth2)"

# --- register consumer ------------------------------------------------------
log "Registering OAuth 2.0 consumer '${CONSUMER_NAME}'"
log "  callback: ${CALLBACK_URL}"
consumer_json="$("${consumer_argv[@]}")" || die "consumer registration failed (see above)"
client_id="$(printf '%s' "$consumer_json" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')"
[ -n "$client_id" ] || die "could not parse consumer key from output: $consumer_json"

# --- optional bot password --------------------------------------------------
bot_user=''; bot_pw=''
if [ "$WITH_BOT" -eq 1 ]; then
	log "Creating bot password (appid mcp-dev) for ${ADMIN_USER}"
	bot_out="$("${botpw_argv[@]}")" || die "bot password creation failed (see above)"
	bot_pw="$(printf '%s' "$bot_out" | sed -n "s/.*password:'\([^']*\)'.*/\1/p")"
	bot_user="$(printf '%s' "$bot_out" | sed -n "s/.*username:'\([^']*\)'.*/\1/p")"
	[ -n "$bot_pw" ] || die "could not parse bot password from output: $bot_out"
fi

# --- emit credentials (stdout) ----------------------------------------------
printf 'OAUTH2_CLIENT_ID=%s\n' "$client_id"
if [ "$WITH_BOT" -eq 1 ]; then
	printf 'MW_DEV_BOT_USER=%s\n' "$bot_user"
	printf 'MW_DEV_BOT_PASSWORD=%s\n' "$bot_pw"
fi

wiki_host="${WIKI_URL#*://}"; wiki_host="${wiki_host%%/*}"   # host[:port]
host_only="${wiki_host%%:*}"
case "$host_only" in
	localhost|127.*|::1|0.0.0.0)
		printf 'MCP_TRUSTED_HOSTS=%s\n' "$wiki_host" ;;
	*)
		log "note: if ${host_only} resolves to a private/internal address, also set MCP_TRUSTED_HOSTS=${wiki_host}" ;;
esac

log "Done. Set oauth2ClientId to \$OAUTH2_CLIENT_ID and start the proxy (see docs/testing.md)."
