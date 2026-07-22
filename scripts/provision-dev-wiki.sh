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

# --- register consumer (only if the stock CLI supports OAuth2) ---------------
# The --oauthVersion / --oauth2IsNotConfidential flags exist only in newer
# Extension:OAuth. The copy bundled with some releases (e.g. the MediaWiki 1.43
# LTS) ships an OAuth1-only createOAuthConsumer.php, so CLI registration of an
# OAuth2 public client is impossible there and must be done in the browser.
# Detect by looking for the public-client flag in the script itself.
client_id=''
if docker exec "$CONTAINER" grep -q 'oauth2IsNotConfidential' "$OAUTH_SCRIPT" 2>/dev/null; then
	log "Registering OAuth 2.0 consumer '${CONSUMER_NAME}'"
	log "  callback: ${CALLBACK_URL}"
	consumer_json="$("${consumer_argv[@]}")" || die "consumer registration failed (see above)"
	client_id="$(printf '%s' "$consumer_json" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')"
	[ -n "$client_id" ] || die "could not parse consumer key from output: $consumer_json"
else
	log "This wiki's Extension:OAuth createOAuthConsumer.php is OAuth1-only (no CLI"
	log "flag for OAuth2 public clients), so the consumer can't be registered from"
	log "the command line here. Register it once in the browser instead:"
	log "  1. On the wiki, open Special:OAuthConsumerRegistration/propose/oauth2"
	log "  2. Callback URL (exact): ${CALLBACK_URL}"
	log "  3. Leave 'This consumer is confidential' UNCHECKED (public + PKCE)."
	log "  4. Grant types: tick Authorization code and Refresh token."
	log "  5. Request the grants your tools need (default set: ${GRANTS})."
	log "  6. Copy the client application key into OAUTH2_CLIENT_ID."
	log "See docs/deployment.md for the field-by-field walkthrough."
fi

# --- optional bot password --------------------------------------------------
bot_user=''; bot_pw=''
if [ "$WITH_BOT" -eq 1 ]; then
	log "Creating bot password (appid mcp-dev) for ${ADMIN_USER}"
	bot_out="$("${botpw_argv[@]}")" || die "bot password creation failed (see above)"
	bot_pw="$(printf '%s' "$bot_out" | sed -n "s/.*password:'\([^']*\)'.*/\1/p")"
	bot_user="$(printf '%s' "$bot_out" | sed -n "s/.*username:'\([^']*\)'.*/\1/p")"
	[ -n "$bot_pw" ] || die "could not parse bot password from output: $bot_out"
	[ -n "$bot_user" ] || die "could not parse bot username from output: $bot_out"
fi

# --- emit credentials (stdout) ----------------------------------------------
# %q-quote every value so `set -a; eval "$( ... )"; set +a` is safe even when a
# value contains shell metacharacters — MediaWiki usernames may contain spaces,
# so `MW_DEV_BOT_USER=First Last@mcp-dev` must be quoted.
if [ -n "$client_id" ]; then
	printf 'OAUTH2_CLIENT_ID=%q\n' "$client_id"
fi
if [ "$WITH_BOT" -eq 1 ]; then
	printf 'MW_DEV_BOT_USER=%q\n' "$bot_user"
	printf 'MW_DEV_BOT_PASSWORD=%q\n' "$bot_pw"
fi

wiki_host="${WIKI_URL#*://}"; wiki_host="${wiki_host%%/*}"   # host[:port] or [ipv6]:port
if [ "${wiki_host#\[}" != "$wiki_host" ]; then
	host_only="${wiki_host#\[}"; host_only="${host_only%%\]*}"   # bare host inside [ ]
else
	host_only="${wiki_host%%:*}"
fi
case "$host_only" in
	localhost | *.localhost | 127.* | ::1 | 0.0.0.0)
		printf 'MCP_TRUSTED_HOSTS=%q\n' "$wiki_host" ;;
	*)
		log "note: if ${host_only} resolves to a private/internal address, also set MCP_TRUSTED_HOSTS=${wiki_host}" ;;
esac

if [ -n "$client_id" ]; then
	log "Done. Set oauth2ClientId to \$OAUTH2_CLIENT_ID and start the proxy (see docs/testing.md)."
else
	log "Done. After registering the consumer in the browser (steps above), set"
	log "OAUTH2_CLIENT_ID to its client key and start the proxy (see docs/testing.md)."
fi
