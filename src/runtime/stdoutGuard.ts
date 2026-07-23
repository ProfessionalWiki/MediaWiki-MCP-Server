import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { Mwn } from 'mwn';
import { emitTelemetryEvent } from './logger.js';

/**
 * Under the stdio transport, stdout carries the JSON-RPC frames and nothing
 * else: one stray line makes the client fail to parse a message. mwn writes its
 * own diagnostics there by default — a successful login, an API warning, a
 * retry — each prefixed with a bracketed timestamp, which a client reports as
 * "Expected ',' or ']' after array element in JSON at position 5".
 *
 * The guard leaves stdout to the transport and routes everything else into the
 * structured stderr log, so operators keep the diagnostics in the same
 * JSON-lines stream as the rest of our output. It covers both transports: on
 * HTTP nothing owns stdout, but raw text there is still invisible to a log
 * pipeline that parses each line as JSON.
 */
export function guardStdout(): void {
	const sink = createLogSink();

	// mwn's logger writes through this stream directly. Pointing it away from
	// process.stdout also disables its chalk colouring, which keys off the
	// stream being stdout, so no escape sequences reach the log.
	Mwn.setLoggingConfig({ stream: sink });

	// mwn also has one hard-coded console.log (a request-failure dump) that the
	// setting above cannot reach, so replace the stdout half of the global
	// console as well. process.stdout itself is deliberately left alone: the
	// SDK's StdioServerTransport writes to it directly, and patching it would
	// break the protocol channel.
	//
	// inspectOptions is left at Node's defaults on purpose. Raising `depth`
	// would expand nested objects such as an axios error's headers, putting
	// Set-Cookie values from a failing wiki response into the log.
	globalThis.console = new Console({ stdout: sink, stderr: process.stderr });
}

function createLogSink(): Writable {
	return new Writable({
		write(chunk: Buffer | string, _encoding: BufferEncoding, callback: () => void): void {
			try {
				report(String(chunk));
			} finally {
				// Node does not guard _write. Skipping the callback would leave the
				// stream mid-write forever, buffering every later line in silence.
				callback();
			}
		},
	});
}

function report(text: string): void {
	// Both producers terminate their writes with a newline, so splitting keeps
	// one structured event per logical line instead of embedding raw newlines.
	for (const line of text.split('\n')) {
		if (line.trim() === '') {
			continue;
		}
		try {
			emitTelemetryEvent('warning', { event: 'stray_stdout', text: line });
		} catch {
			// Node's Console swallows sink errors, so a throwing logger would
			// discard the line without a trace. Keep it, unstructured.
			process.stderr.write(line + '\n');
		}
	}
}
