#!/bin/bash

# Script to manage the development environment for the MCP server

ENTRYPOINT="${1:-build/index.js}"
NODE_VERSION="${2:-22}"

# Variables for cleanup
DOCKER_WATCHER_NAME="mcp_server_watcher"
INSPECTOR_PID=""
TEE_PID=""
FIFO_FOR_TEE=""
TEMP_LOG_FILE=""
CLEANUP_HAD_ISSUES=false

# Start the watcher container
docker run -d --name "$DOCKER_WATCHER_NAME" --rm -v "$(pwd)":/home/node/app -w /home/node/app -u node node:$NODE_VERSION npm run watch
echo "👀 Watcher container '$DOCKER_WATCHER_NAME' started."

WSL_IP_MESSAGE=""

# Check if running in Windows Subsystem for Linux (WSL) and set IP message accordingly
if grep -qE "(Microsoft|WSL)" /proc/version 2>/dev/null; then
    WSL_IP=$(hostname -I | awk '{print $1}')
    if [ -n "$WSL_IP" ]; then
        WSL_IP_MESSAGE="If accessing from WSL host, also try: http://$WSL_IP:6274"
    fi
fi

cleanup() {
    echo
    echo "🧹 Initiating cleanup sequence..."
    CLEANUP_HAD_ISSUES=false # Reset at the start of cleanup

    # Attempt to stop watcher container
    if ! docker stop "$DOCKER_WATCHER_NAME" >/dev/null 2>&1; then
        # Check if it was already stopped or if stop truly failed
        if docker ps -q --filter "name=$DOCKER_WATCHER_NAME" | grep -q .; then
             echo "⚠️ Failed to stop watcher container $DOCKER_WATCHER_NAME."
             CLEANUP_HAD_ISSUES=true
        fi
    fi

    if [ -n "$INSPECTOR_PID" ]; then
        if kill -0 "$INSPECTOR_PID" 2>/dev/null; then
            kill "$INSPECTOR_PID" 2>/dev/null
            if kill -0 "$INSPECTOR_PID" 2>/dev/null; then 
                echo "⚠️ Inspector process $INSPECTOR_PID may not have terminated cleanly."
                CLEANUP_HAD_ISSUES=true
            fi
        fi
    fi

    if [ -n "$TEE_PID" ]; then
        if kill -0 "$TEE_PID" 2>/dev/null; then
            kill "$TEE_PID" 2>/dev/null
            if kill -0 "$TEE_PID" 2>/dev/null; then 
                echo "⚠️ tee process $TEE_PID may not have terminated cleanly."
                CLEANUP_HAD_ISSUES=true
            fi
        fi
    fi
    
    if [ -n "$FIFO_FOR_TEE" ]; then
        if [ -p "$FIFO_FOR_TEE" ]; then
            rm -f "$FIFO_FOR_TEE"
        elif [ -e "$FIFO_FOR_TEE" ]; then 
            echo "⚠️ Expected FIFO $FIFO_FOR_TEE was not a pipe, attempting removal."
            rm -f "$FIFO_FOR_TEE"
            CLEANUP_HAD_ISSUES=true
        fi 
    fi

    if [ -n "$TEMP_LOG_FILE" ]; then
        if [ -f "$TEMP_LOG_FILE" ]; then
            rm -f "$TEMP_LOG_FILE"
        elif [ -e "$TEMP_LOG_FILE" ]; then 
            echo "⚠️ Expected temporary log file $TEMP_LOG_FILE was not a regular file, attempting removal."
            rm -f "$TEMP_LOG_FILE"
            CLEANUP_HAD_ISSUES=true
        fi 
    fi

    if [ "$CLEANUP_HAD_ISSUES" = true ]; then
        echo "🧼 Cleanup sequence completed with issues noted above."
    else
        echo "🧼 Cleanup sequence completed successfully."
    fi
}

trap 'echo; cleanup; echo "👋 Subshell exiting due to signal."; exit 130' INT
trap 'echo; cleanup; echo "👋 Subshell exiting due to signal."; exit 143' TERM

TEMP_LOG_FILE=$(mktemp) || { echo "❌ Failed to create temporary log file. Aborting."; cleanup; exit 1; }
FIFO_BASENAME=$(mktemp -u mcp_inspector_fifo.XXXXXX) || { echo "❌ Failed to generate temporary FIFO name. Aborting."; cleanup; exit 1; }
FIFO_FOR_TEE="/tmp/${FIFO_BASENAME}"
mkfifo "$FIFO_FOR_TEE" || { echo "❌ Failed to create FIFO '$FIFO_FOR_TEE'. Aborting."; cleanup; exit 1; }

tee "$TEMP_LOG_FILE" < "$FIFO_FOR_TEE" &
TEE_PID=$!
if [ -z "$TEE_PID" ]; then
    echo "❌ Failed to start tee process. Aborting."
    cleanup
    exit 1
fi

(npx -y @modelcontextprotocol/inspector node "$ENTRYPOINT" > "$FIFO_FOR_TEE" 2>&1) &
INSPECTOR_PID=$!

if [ -z "$INSPECTOR_PID" ]; then
    echo "❌ Failed to start inspector process or capture its PID. Aborting."
    cleanup
    exit 1
fi

TARGET_MESSAGE="🔍 MCP Inspector is up and running at http://127.0.0.1:6274"
MAX_WAIT_SECONDS=60
SECONDS_WAITED=0
SUCCESS_MSG_FOUND=false

while [ "$SECONDS_WAITED" -lt "$MAX_WAIT_SECONDS" ]; do
    if grep -qF "$TARGET_MESSAGE" "$TEMP_LOG_FILE"; then
        SUCCESS_MSG_FOUND=true
        break
    fi

    if ! kill -0 "$INSPECTOR_PID" 2>/dev/null; then
        echo "❌ Inspector process (PID $INSPECTOR_PID) exited prematurely before signaling readiness."
        echo "   Output from inspector (via $TEMP_LOG_FILE) up to this point:"
        if [ -s "$TEMP_LOG_FILE" ]; then cat "$TEMP_LOG_FILE"; else echo "   (Log file is empty or was not readable)"; fi
        cleanup 
        exit 1
    fi

    sleep 1
    SECONDS_WAITED=$((SECONDS_WAITED + 1))
done

if [ "$SUCCESS_MSG_FOUND" = false ]; then
    echo "⌛ Timeout: MCP Inspector did not signal readiness within $MAX_WAIT_SECONDS seconds."
    echo "   Check output above and content of $TEMP_LOG_FILE:"
    if [ -s "$TEMP_LOG_FILE" ]; then cat "$TEMP_LOG_FILE"; else echo "   (Log file is empty or was not readable)"; fi
    cleanup 
    exit 1
fi

if [ -n "$WSL_IP_MESSAGE" ]; then
    echo "🔗 $WSL_IP_MESSAGE"
fi
echo "✅ Inspector is up and running (PID $INSPECTOR_PID). Watcher $DOCKER_WATCHER_NAME is running."
echo "ℹ️ Press Ctrl+C to stop all services (watcher, inspector, tee)."

wait "$INSPECTOR_PID"
INSPECTOR_EXIT_CODE=$?
echo "ℹ️ Inspector process (PID $INSPECTOR_PID) exited with code $INSPECTOR_EXIT_CODE."

echo "🏁 Inspector process completed. Performing final cleanup..."
cleanup
echo "👋 Subshell exiting with code $INSPECTOR_EXIT_CODE."
exit "$INSPECTOR_EXIT_CODE" 