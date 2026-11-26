export function stripTrailingSlashes(s: string): string {
	let end = s.length;
	while (end > 0 && s[end - 1] === '/') {
		end--;
	}
	return s.slice(0, end);
}
