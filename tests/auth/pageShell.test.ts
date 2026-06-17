import { describe, it, expect } from 'vitest';
import { renderPage, renderIcon, esc } from '../../src/auth/pageShell.js';

describe('pageShell', () => {
	it('escapes HTML metacharacters', () => {
		expect(esc(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
	});

	it('renders a full document with the title in <title> and <h1>', () => {
		const html = renderPage({
			title: 'Authorize application',
			icon: { name: 'lock' },
			body: '<p>hi</p>',
		});
		expect(html.startsWith('<!doctype html>')).toBe(true);
		expect(html).toContain('<html lang="en">');
		expect(html).toContain('<title>Authorize application</title>');
		expect(html).toContain('<h1 class="pg-title">Authorize application</h1>');
		expect(html).toContain('<p>hi</p>');
	});

	it('escapes the title', () => {
		const html = renderPage({ title: '<x>', icon: { name: 'error', accent: 'error' }, body: '' });
		expect(html).not.toContain('<title><x></title>');
		expect(html).toContain('&lt;x&gt;');
	});

	it('renders a 56px inline SVG icon for each name', () => {
		for (const name of ['lock', 'cancel', 'error', 'success'] as const) {
			const svg = renderIcon(name);
			expect(svg).toContain('width="56" height="56"');
			expect(svg).toContain('<path d="');
		}
	});

	it('supports dark mode via light-dark() with a fallback and color-scheme', () => {
		const html = renderPage({ title: 'T', icon: { name: 'success', accent: 'success' }, body: '' });
		expect(html).toContain('color-scheme: light dark');
		expect(html).toContain('light-dark(');
		expect(html).toMatch(/--c-base:#202122;\s*--c-base:light-dark\(#202122,#eaecf0\)/);
	});

	it('has no external asset references', () => {
		const html = renderPage({ title: 'T', icon: { name: 'lock' }, body: '<p>x</p>' });
		expect(html).not.toMatch(/https?:\/\//);
		expect(html).not.toContain('<link');
		expect(html).not.toContain('<script');
	});
});
