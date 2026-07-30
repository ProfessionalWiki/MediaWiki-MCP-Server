import type { MockInstance } from 'vitest';

// The logger writes NDJSON to stderr, so suites that assert on what was logged
// read it back through a spy on process.stderr.write.
export type StderrWriteSpy = MockInstance<typeof process.stderr.write>;
