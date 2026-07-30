// Eight RFC 5424 severity levels, in ascending-severity order, matching the
// level field in each JSON stderr line.
export type LogLevel =
	| 'debug'
	| 'info'
	| 'notice'
	| 'warning'
	| 'error'
	| 'critical'
	| 'alert'
	| 'emergency';

export type LogContext = Record<string, unknown>;

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

function emit(level: LogLevel, message: string, data?: LogContext): void {
	if (LEVEL_RANK[level] < currentThreshold()) {
		return;
	}
	const line = buildLogObject(level, message, data);
	process.stderr.write(JSON.stringify(line) + '\n');
}

// Emits a structured event line carrying an `event` field instead of a
// `message` (e.g. tool_call events for operator-facing telemetry).
export function emitTelemetryEvent(level: LogLevel, data: LogContext): void {
	emit(level, '', data);
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
