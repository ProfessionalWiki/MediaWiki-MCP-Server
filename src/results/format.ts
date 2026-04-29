// Generic recursive markdown formatter for tool payloads. Renders any
// JSON-shaped value as human-readable text suitable for an MCP CallToolResult
// content block. Handles flat objects, nested objects, arrays of primitives,
// arrays of objects, optional fields (undefined values are omitted), and long
// string fields (rendered as their own block rather than inline).

const INLINE_STRING_LIMIT = 120;

// Acronyms / abbreviations that should appear all-caps when they make up a
// camelCase segment of a field name. Matches the title-cased form so the
// lookup is straightforward.
const ABBREVIATIONS = new Set([
	'Id',
	'Url',
	'Uri',
	'Html',
	'Json',
	'Mime',
	'Api',
	'Mw',
	'Css',
	'Sql',
	'Xml',
	'Csrf',
	'Http',
	'Https',
	'Utf',
	'Ip',
	'Md',
	'Tsv',
	'Csv',
	'Pdf',
	'Svg',
	'Wsl',
]);

export function formatPayload(data: unknown): string {
	const rendered = renderValue(data, '').trim();
	return rendered.length > 0 ? rendered : '(empty)';
}

function humanizeKey(key: string): string {
	const words = key
		.replace(/([A-Z])/g, ' $1')
		.trim()
		.split(/\s+/);
	return words
		.map((word, i) => {
			const titleCased = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
			if (ABBREVIATIONS.has(titleCased)) {
				return titleCased.toUpperCase();
			}
			return i === 0 ? titleCased : word.toLowerCase();
		})
		.join(' ');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderValue(value: unknown, indent: string): string {
	if (value === null || value === undefined) {
		return '—';
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (Array.isArray(value)) {
		return renderArray(value, indent);
	}
	if (isPlainObject(value)) {
		return renderObject(value, indent);
	}
	return stringifyUnknown(value);
}

function renderObject(obj: Record<string, unknown>, indent: string): string {
	const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
	if (entries.length === 0) {
		return '(empty)';
	}
	return entries.map(([key, value]) => renderField(humanizeKey(key), value, indent)).join('\n');
}

function renderField(label: string, value: unknown, indent: string): string {
	const prefix = `${indent}${label}:`;
	if (value === null || value === undefined) {
		return `${prefix} —`;
	}
	if (typeof value === 'string') {
		if (value === '') {
			return `${prefix} (empty)`;
		}
		if (value.length <= INLINE_STRING_LIMIT && !value.includes('\n')) {
			return `${prefix} ${value}`;
		}
		return `${prefix}\n\n${value}`;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return `${prefix} ${value}`;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return `${prefix} (none)`;
		}
		return `${prefix}\n${renderArray(value, indent)}`;
	}
	if (isPlainObject(value)) {
		return `${prefix}\n${renderObject(value, indent + '  ')}`;
	}
	return `${prefix} ${stringifyUnknown(value)}`;
}

function renderArray(arr: unknown[], indent: string): string {
	const itemIndent = `${indent}- `;
	const continuationIndent = `${indent}  `;
	return arr
		.map((item) => {
			if (item === null || item === undefined) {
				return `${itemIndent}—`;
			}
			if (typeof item === 'string') {
				return `${itemIndent}${item === '' ? '(empty)' : item}`;
			}
			if (typeof item === 'number' || typeof item === 'boolean') {
				return `${itemIndent}${item}`;
			}
			if (Array.isArray(item)) {
				return `${itemIndent}\n${renderArray(item, continuationIndent)}`;
			}
			if (isPlainObject(item)) {
				const objText = renderObject(item, continuationIndent);
				const lines = objText.split('\n');
				if (lines.length === 0) {
					return `${itemIndent}(empty)`;
				}
				// Place first field on the dash line; subsequent fields continue
				// at the continuationIndent column already produced by renderObject.
				const [first, ...rest] = lines;
				const firstStripped = first.startsWith(continuationIndent)
					? first.slice(continuationIndent.length)
					: first;
				return [`${itemIndent}${firstStripped}`, ...rest].join('\n');
			}
			return `${itemIndent}${stringifyUnknown(item)}`;
		})
		.join('\n');
}

// Last-resort renderer for values that are not null/undefined/string/number/
// boolean/array/plain-object — typically class instances or other exotic
// shapes that slip into a payload typed as `unknown`. JSON.stringify avoids
// the bare `[object Object]` that `String()` would produce; if the value
// still can't be serialised (e.g., a circular reference or a BigInt), fall
// back to its constructor name so the output stays diagnostic rather than
// throwing or printing nothing useful.
function stringifyUnknown(value: unknown): string {
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) {
			return json;
		}
	} catch {
		// fall through to constructor-name fallback
	}
	const ctor =
		typeof value === 'object' && value !== null
			? (value.constructor?.name ?? 'Object')
			: typeof value;
	return `[${ctor}]`;
}
