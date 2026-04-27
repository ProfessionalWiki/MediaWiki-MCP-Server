// Phase 6 will move the implementation. Phase 1 re-exports so the new
// ToolContext type compiles.
export { logger, registerServer, unregisterServer } from '../common/logger.js';
export type { Logger, LogLevel, LogMeta } from '../common/logger.js';
