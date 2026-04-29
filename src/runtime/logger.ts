import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LoggingLevel } from '@modelcontextprotocol/sdk/types.js';

// Eight RFC 5424 severity levels, in the order LoggingLevelSchema declares them.
// Used both for the level field in the JSON stderr line and the
// LoggingMessageNotification the SDK forwards to clients.
export type LogLevel = LoggingLevel;

export type LogContext = Record<string, unknown>;

const LOGGER_NAME = 'mediawiki-mcp-server';

const servers: Set<McpServer> = new Set();

export function registerServer(server: McpServer): void {
	servers.add(server);
}

export function unregisterServer(server: McpServer): void {
	servers.delete(server);
}

// Test-only: callers must not rely on these in production code.
export function clearRegisteredServers(): void {
	servers.clear();
}

export function getRegisteredServerCount(): number {
	return servers.size;
}

const RESERVED_KEYS = new Set<string>(['ts', 'level', 'message']);

const LEVEL_RANK: Record<LogLevel | 'silent', number> = {
	debug: 0,
	info: 1,
	notice: 2,
	warning: 3,
	error: 4,
	critical: 5,
	alert: 6,
	emergency: 7,
	silent: 8,
};

function isThresholdKey(raw: string): raw is keyof typeof LEVEL_RANK {
	return Object.hasOwn(LEVEL_RANK, raw);
}

function currentThreshold(): number {
	const raw = process.env.MCP_LOG_LEVEL;
	if (raw === undefined || raw === '') {
		return LEVEL_RANK.debug;
	}
	if (!isThresholdKey(raw)) {
		const valid = Object.keys(LEVEL_RANK).join(', ');
		throw new Error(`Invalid MCP_LOG_LEVEL "${raw}". Valid values: ${valid}.`);
	}
	return LEVEL_RANK[raw];
}

function buildLogObject(
	level: LogLevel,
	message: string,
	data?: LogContext,
): Record<string, unknown> {
	const obj: Record<string, unknown> = {};
	if (data !== undefined) {
		for (const [key, value] of Object.entries(data)) {
			if (!RESERVED_KEYS.has(key)) {
				obj[key] = value;
			}
		}
	}
	obj.ts = new Date().toISOString();
	obj.level = level;
	if (message !== '') {
		obj.message = message;
	}
	return obj;
}

// Best-effort handler. The SDK already filters by per-session setLevel and skips
// when capabilities.logging is unset, and we have already written stderr for the
// operator. Failing here would be unhelpful noise.
const swallowNotificationError = (): undefined => undefined;

// Emits a structured event to stderr only, bypassing the MCP
// sendLoggingMessage broadcast. Used for operator-facing telemetry
// (e.g. tool_call events) that must not leak to connected clients.
export function emitTelemetryEvent(level: LogLevel, data: LogContext): void {
	if (LEVEL_RANK[level] < currentThreshold()) {
		return;
	}
	const line = buildLogObject(level, '', data);
	process.stderr.write(JSON.stringify(line) + '\n');
}

function emit(level: LogLevel, message: string, data?: LogContext): void {
	if (LEVEL_RANK[level] < currentThreshold()) {
		return;
	}
	const line = buildLogObject(level, message, data);
	process.stderr.write(JSON.stringify(line) + '\n');

	if (servers.size === 0) {
		return;
	}

	const payload: LogContext = data === undefined ? { message } : { message, ...data };
	for (const server of servers) {
		server
			.sendLoggingMessage({
				level,
				logger: LOGGER_NAME,
				data: payload,
			})
			.catch(swallowNotificationError);
	}
}

export const logger = {
	debug: (message: string, data?: LogContext): void => emit('debug', message, data),
	info: (message: string, data?: LogContext): void => emit('info', message, data),
	notice: (message: string, data?: LogContext): void => emit('notice', message, data),
	warning: (message: string, data?: LogContext): void => emit('warning', message, data),
	error: (message: string, data?: LogContext): void => emit('error', message, data),
	critical: (message: string, data?: LogContext): void => emit('critical', message, data),
	alert: (message: string, data?: LogContext): void => emit('alert', message, data),
	emergency: (message: string, data?: LogContext): void => emit('emergency', message, data),
};

export type Logger = typeof logger;
export type LogMeta = LogContext;
