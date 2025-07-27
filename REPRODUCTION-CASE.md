# MediaWiki OAuth 2.0 + REST API CSRF Token Issue - Minimal Reproduction Case

## Summary
MediaWiki's REST API does not properly recognize OAuth 2.0 Bearer tokens as CSRF-safe authentication, causing write operations to fail with "rest-badtoken" errors.

## Environment
- **MediaWiki Version**: 1.44 
- **OAuth Extension Version**: 1.1.0
- **Issue**: REST API requires CSRF tokens even when using OAuth 2.0 Bearer authentication

## Reproduction Steps

### 1. Setup OAuth 2.0 Application
```bash
# Register OAuth 2.0 application at: Special:OAuthConsumerRegistration/propose/oauth2
# Grants needed: basic, createeditmovedpage, editpage
# Get: Client ID, Client Secret, Access Token (JWT)
```

### 2. Test Legacy Action API (Works ✅)
```bash
# Get CSRF token via legacy API
curl -H "Authorization: Bearer $TOKEN" \
  "https://wiki.example.com/api.php?action=query&meta=tokens&type=csrf&format=json"

# Create page via legacy API (SUCCESS)
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "action=edit&title=Test&text=Content&token=$CSRF_TOKEN&format=json" \
  "https://wiki.example.com/api.php"
```

**Result**: ✅ OAuth 2.0 works perfectly with legacy Action API

### 3. Test REST API (Fails ❌)
```bash
# Try to create page via REST API
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source": "Content", "title": "Test", "comment": "Test"}' \
  "https://wiki.example.com/rest.php/v1/page"
```

**Result**: ❌ Fails with error:
```json
{
  "errorKey": "rest-badtoken",
  "messageTranslations": {
    "en": "The <var>token</var> parameter is required unless using a CSRF-safe authentication method."
  },
  "httpCode": 403,
  "httpReason": "Forbidden"
}
```

## Root Cause Analysis

### MediaWiki OAuth Extension
- OAuth extension provides `SessionProvider` with `safeAgainstCsrf() = true`
- OAuth 2.0 Bearer tokens should be recognized as CSRF-safe
- Legacy Action API correctly recognizes OAuth as CSRF-safe

### REST API TokenAwareHandlerTrait  
- File: `includes/Rest/TokenAwareHandlerTrait.php`
- Method: `needsToken()` checks `$this->getSession()->getProvider()->safeAgainstCsrf()`
- **Issue**: REST API fails to associate OAuth Bearer tokens with OAuth SessionProvider

### Expected vs Actual Behavior

**Expected**: 
- OAuth 2.0 Bearer token → OAuth SessionProvider → `safeAgainstCsrf() = true` → No CSRF token needed

**Actual**:
- OAuth 2.0 Bearer token → Not recognized by REST API → Default session → CSRF token required

## Workaround Implemented

The MediaWiki MCP Server now includes a fallback mechanism:

1. **Try REST API first** (preserves future compatibility)
2. **If REST API fails with CSRF/token errors** → Automatically fall back to legacy Action API
3. **Legacy Action API works correctly** with OAuth 2.0 

## Test Evidence

### Direct Legacy API Test
```javascript
// This works:
const csrfToken = await fetch('/api.php?action=query&meta=tokens&type=csrf&format=json', {
  headers: { 'Authorization': `Bearer ${token}` }
});

const result = await fetch('/api.php', {
  method: 'POST', 
  headers: { 'Authorization': `Bearer ${token}` },
  body: new URLSearchParams({ action: 'edit', title: 'Test', text: 'Content', token: csrfToken })
});
// → SUCCESS: Page created
```

### REST API Test  
```javascript
// This fails:
const result = await fetch('/rest.php/v1/page', {
  method: 'POST',
  headers: { 
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json' 
  },
  body: JSON.stringify({ source: 'Content', title: 'Test' })
});
// → ERROR: rest-badtoken
```

## Impact
- **OAuth 2.0 + REST API write operations fail** (create-page, update-page)
- **OAuth 2.0 + legacy Action API works correctly**
- **Read operations work fine** (no CSRF tokens needed)

## Related Issues
- [Phabricator T234665](https://phabricator.wikimedia.org/T234665) - Add OAuth 2.0 support to MediaWiki REST API
- MediaWiki REST API documentation claims OAuth 2.0 is "the primary authorization mechanism"
- SessionProvider integration appears incomplete for REST API endpoints

## Solution Status
✅ **Workaround implemented**: Automatic fallback to legacy Action API for write operations  
⏳ **Upstream fix needed**: REST API should recognize OAuth 2.0 SessionProvider as CSRF-safe