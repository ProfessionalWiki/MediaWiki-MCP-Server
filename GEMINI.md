# MediaWiki-MCP-Server URL Bug Debugging Plan

This document outlines the steps to debug and fix the malformed URL issue in the `mediawiki-mcp-server`'s `create-page` tool. The server is generating URLs with a double slash (e.g., `https://wiki.starfishenglish.com//rest.php/...`).

## Current Status
- The `mediawiki-mcp-server` is currently running in `stdio` mode.
- Previous attempts to fix the URL construction directly in `src/common/utils.ts` have been unsuccessful.
- Attempts to switch the server to `http` mode for easier debugging were also problematic.

## Plan of Action

1.  **Re-apply `console.log` to `fetchCore`:**
    -   Modify `src/common/utils.ts` to add a `console.log('Final URL:', url);` statement just before the `fetch(url, fetchOptions)` call within the `fetchCore` function.

2.  **Rebuild `mediawiki-mcp-server`:**
    -   Run `npm run build` to compile the TypeScript changes.

3.  **Restart `mediawiki-mcp-server` with logging:**
    -   Identify and kill any existing `node` processes related to `mediawiki-mcp-server`.
    -   Start the server using `npm start > mcp.log 2>&1 &` to redirect all output to `mcp.log` in the project root.

4.  **Call `create-page` tool:**
    -   Execute the `create-page` tool with test data (e.g., `create_page(source="This is a test page.", title="Test Page")`). This will trigger the URL construction and the `console.log` statement.

5.  **Inspect `mcp.log` for malformed URL:**
    -   Read the content of `mcp.log` to find the exact URL that was constructed and passed to `fetch`.

6.  **Analyze and fix URL construction:**
    -   Based on the logged URL, precisely identify the source of the double slash.
    -   Apply the correct fix to the URL construction logic in `src/common/utils.ts` within the `makeRestGetRequest`, `makeRestPutRequest`, and `makeRestPostRequest` functions.

7.  **Rebuild `mediawiki-mcp-server` (after fix):**
    -   Run `npm run build` again to compile the corrected code.

8.  **Restart `mediawiki-mcp-server` (after fix):**
    -   Identify and kill any existing `node` processes related to `mediawiki-mcp-server`.
    -   Start the server using `npm start > mcp.log 2>&1 &`.

9.  **Verify fix:**
    -   Call the `create-page` tool again.
    -   Confirm that the page is created successfully and there are no malformed URL errors.
