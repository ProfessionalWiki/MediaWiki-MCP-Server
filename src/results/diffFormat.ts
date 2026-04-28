const NAMED_ENTITIES: Record<string, string> = {
	'&lt;': '<',
	'&gt;': '>',
	'&amp;': '&',
	'&quot;': '"',
	'&apos;': "'",
	'&nbsp;': ' ',
};

function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
			const cp = parseInt(code, 16);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
		})
		.replace(/&#(\d+);/g, (_, code) => {
			const cp = parseInt(code, 10);
			return Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
		})
		.replace(/&(?:lt|gt|amp|quot|apos|nbsp);/g, (m) => NAMED_ENTITIES[m] ?? m);
}

function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, '')).trim();
}

interface Cell {
	className: string;
	inner: string;
}

function extractCells(rowHtml: string): Cell[] {
	const cells: Cell[] = [];
	const cellRegex = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
	let match;
	while ((match = cellRegex.exec(rowHtml)) !== null) {
		const classMatch = match[1].match(/class\s*=\s*"([^"]*)"/i);
		cells.push({
			className: classMatch ? classMatch[1] : '',
			inner: match[2],
		});
	}
	return cells;
}

function findCell(cells: Cell[], classFragment: string): Cell | undefined {
	return cells.find((c) => c.className.includes(classFragment));
}

export function inlineDiffToText(html: string): string {
	if (!html) {
		return '';
	}

	const lines: string[] = [];
	const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
	let rowMatch;

	while ((rowMatch = rowRegex.exec(html)) !== null) {
		const cells = extractCells(rowMatch[1]);

		const linenoCell = findCell(cells, 'diff-lineno');
		if (linenoCell) {
			const text = stripTags(linenoCell.inner);
			const m = text.match(/Line\s+(\d+)/i);
			if (m) {
				lines.push(`@@ Line ${m[1]} @@`);
			}
			continue;
		}

		const contextCell = findCell(cells, 'diff-context');
		if (contextCell) {
			lines.push('  ' + stripTags(contextCell.inner));
			continue;
		}

		const deleted = findCell(cells, 'diff-deletedline');
		const added = findCell(cells, 'diff-addedline');

		if (deleted) {
			lines.push('- ' + stripTags(deleted.inner));
		}
		if (added) {
			lines.push('+ ' + stripTags(added.inner));
		}
	}

	return lines.join('\n');
}
