import { inflateSync } from 'node:zlib';

/**
 * Extracts the text operands of PDF content streams without a PDF library.
 * Reading wiki PDFs is a best-effort text preview: a stream is inflated with
 * the standard Flate filter, then string literals are decoded with PDF's
 * escapes. Streams with other filters are skipped; those bytes are not
 * content text, so guessing at them would produce mojibake.
 */
export function extractPdfText(bytes: Buffer): string {
	const source = bytes.toString('latin1');
	const chunks: string[] = [];
	for (const match of source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
		const raw = match[1];
		if (raw === undefined) {
			continue;
		}
		let content: string;
		try {
			content = inflateSync(Buffer.from(raw, 'latin1')).toString('latin1');
		} catch {
			content = raw;
		}
		const text = operandsOf(content);
		if (text !== '') {
			chunks.push(text);
		}
	}
	return chunks.join('\n\n');
}

// Only string operands are extracted: numbers select glyph spacing and other
// operators draw or position text, neither of which carries readable content.
function operandsOf(content: string): string {
	const strings: string[] = [];
	for (let i = 0; i < content.length; i++) {
		if (content[i] === '(') {
			const [value, next] = readLiteral(content, i);
			strings.push(value);
			i = next;
		} else if (content[i] === '<' && content[i + 1] !== '<') {
			const end = content.indexOf('>', i + 1);
			if (end !== -1) {
				const hex = content.slice(i + 1, end).replace(/\s+/g, '');
				if (hex.length % 2 === 0) {
					const decoded = Buffer.from(hex, 'hex').toString('utf8');
					if (decoded.trim() !== '') {
						strings.push(decoded);
					}
				}
				i = end;
			}
		}
	}
	return strings.join(' ').trim();
}

function readLiteral(content: string, open: number): [string, number] {
	let depth = 1;
	let value = '';
	let i = open + 1;
	while (i < content.length && depth > 0) {
		const char = content[i];
		if (char === '\\') {
			const escaped = content[i + 1];
			if (escaped === undefined) {
				break;
			}
			if (/[0-7]/.test(escaped)) {
				let octal = escaped;
				let j = i + 2;
				while (octal.length < 3 && /[0-7]/.test(content[j] ?? '')) {
					octal += content[j];
					j++;
				}
				value += String.fromCharCode(Number.parseInt(octal, 8));
				i = j;
				continue;
			}
			value += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[escaped] ?? escaped;
			i += 2;
			continue;
		}
		if (char === '(') {
			depth++;
		} else if (char === ')') {
			depth--;
			if (depth === 0) {
				break;
			}
		}
		value += char;
		i++;
	}
	return [value, i];
}
