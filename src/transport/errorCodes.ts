// JSON-RPC error codes for conditions this transport detects itself, before the
// MCP handler sees the request. JSON-RPC reserves -32768..-32000, and MCP forbids
// allocating new codes in the -32000..-32019 sub-range and directs new codes for
// purposes it does not define to sit outside the reserved range entirely, so these
// live above it. -32001 in particular also means "session not found" by SDK
// convention.
export const AUTHENTICATION_REQUIRED_ERROR_CODE = -31001;
export const UPSTREAM_UNAVAILABLE_ERROR_CODE = -31002;
export const PAYLOAD_TOO_LARGE_ERROR_CODE = -31003;
export const RATE_LIMITED_ERROR_CODE = -31004;
