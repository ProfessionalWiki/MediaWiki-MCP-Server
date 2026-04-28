import { describe, it, expect } from 'vitest';
import { inlineDiffToText } from '../../src/results/diffFormat.js';

describe( 'inlineDiffToText', () => {
	it( 'returns empty string for empty input', () => {
		expect( inlineDiffToText( '' ) ).toBe( '' );
	} );

	it( 'emits a chunk header for diff-lineno rows', () => {
		const html = '<tr><td colspan="2" class="diff-lineno">Line 42:</td><td colspan="2" class="diff-lineno">Line 42:</td></tr>';
		expect( inlineDiffToText( html ) ).toBe( '@@ Line 42 @@' );
	} );

	it( 'emits unchanged context with a two-space prefix', () => {
		const html = '<tr><td colspan="2" class="diff-context"><div>hello world</div></td><td colspan="2" class="diff-context"><div>hello world</div></td></tr>';
		expect( inlineDiffToText( html ) ).toBe( '  hello world' );
	} );

	it( 'emits - then + for a paired change row', () => {
		const html = [
			'<tr>',
			'<td class="diff-marker">-</td>',
			'<td class="diff-deletedline"><div>hello old</div></td>',
			'<td class="diff-marker">+</td>',
			'<td class="diff-addedline"><div>hello new</div></td>',
			'</tr>'
		].join( '' );
		expect( inlineDiffToText( html ) ).toBe( '- hello old\n+ hello new' );
	} );

	it( 'emits only - for a pure deletion row', () => {
		const html = [
			'<tr>',
			'<td class="diff-marker">-</td>',
			'<td class="diff-deletedline"><div>removed line</div></td>',
			'<td colspan="2" class="diff-empty">&nbsp;</td>',
			'</tr>'
		].join( '' );
		expect( inlineDiffToText( html ) ).toBe( '- removed line' );
	} );

	it( 'emits only + for a pure addition row', () => {
		const html = [
			'<tr>',
			'<td colspan="2" class="diff-empty">&nbsp;</td>',
			'<td class="diff-marker">+</td>',
			'<td class="diff-addedline"><div>added line</div></td>',
			'</tr>'
		].join( '' );
		expect( inlineDiffToText( html ) ).toBe( '+ added line' );
	} );

	it( 'strips inner diffchange markers while preserving text', () => {
		const html = [
			'<tr>',
			'<td class="diff-marker">-</td>',
			'<td class="diff-deletedline"><div>hello <del class="diffchange">old</del> world</div></td>',
			'<td class="diff-marker">+</td>',
			'<td class="diff-addedline"><div>hello <ins class="diffchange">new</ins> world</div></td>',
			'</tr>'
		].join( '' );
		expect( inlineDiffToText( html ) ).toBe( '- hello old world\n+ hello new world' );
	} );

	it( 'decodes HTML entities in cell content', () => {
		const html = '<tr><td colspan="2" class="diff-context"><div>a &lt;b&gt; &amp; c&#39;s &#x2F; &#47;</div></td><td colspan="2" class="diff-context"><div>same</div></td></tr>';
		expect( inlineDiffToText( html ) ).toBe( "  a <b> & c's / /" );
	} );

	it( 'handles multiple rows in order', () => {
		const html = [
			'<table class="diff">',
			'<tr><td colspan="2" class="diff-lineno">Line 1:</td><td colspan="2" class="diff-lineno">Line 1:</td></tr>',
			'<tr><td colspan="2" class="diff-context"><div>one</div></td><td colspan="2" class="diff-context"><div>one</div></td></tr>',
			'<tr><td class="diff-marker">-</td><td class="diff-deletedline"><div>two</div></td><td class="diff-marker">+</td><td class="diff-addedline"><div>2</div></td></tr>',
			'</table>'
		].join( '' );
		expect( inlineDiffToText( html ) ).toBe( '@@ Line 1 @@\n  one\n- two\n+ 2' );
	} );

	it( 'strips unknown tags gracefully', () => {
		const html = '<tr><td colspan="2" class="diff-context"><div><span class="x"><em>hi</em></span></div></td><td colspan="2" class="diff-context"><div><span>hi</span></div></td></tr>';
		expect( inlineDiffToText( html ) ).toBe( '  hi' );
	} );

	it( 'handles multiple diff-lineno rows in one body', () => {
		const html = [
			'<table class="diff">',
			'<tr><td colspan="2" class="diff-lineno">Line 5:</td><td colspan="2" class="diff-lineno">Line 5:</td></tr>',
			'<tr><td colspan="2" class="diff-context"><div>a</div></td><td colspan="2" class="diff-context"><div>a</div></td></tr>',
			'<tr><td colspan="2" class="diff-lineno">Line 20:</td><td colspan="2" class="diff-lineno">Line 20:</td></tr>',
			'<tr><td colspan="2" class="diff-context"><div>b</div></td><td colspan="2" class="diff-context"><div>b</div></td></tr>',
			'</table>'
		].join( '' );
		expect( inlineDiffToText( html ) ).toBe( '@@ Line 5 @@\n  a\n@@ Line 20 @@\n  b' );
	} );

	it( 'handles a mixed body with lineno, context, pure delete, and pure add', () => {
		const html = [
			'<table class="diff">',
			'<tr><td colspan="2" class="diff-lineno">Line 1:</td><td colspan="2" class="diff-lineno">Line 1:</td></tr>',
			'<tr><td colspan="2" class="diff-context"><div>intro</div></td><td colspan="2" class="diff-context"><div>intro</div></td></tr>',
			'<tr><td class="diff-marker">-</td><td class="diff-deletedline"><div>gone</div></td><td colspan="2" class="diff-empty">&nbsp;</td></tr>',
			'<tr><td colspan="2" class="diff-empty">&nbsp;</td><td class="diff-marker">+</td><td class="diff-addedline"><div>fresh</div></td></tr>',
			'<tr><td colspan="2" class="diff-context"><div>outro</div></td><td colspan="2" class="diff-context"><div>outro</div></td></tr>',
			'</table>'
		].join( '' );
		expect( inlineDiffToText( html ) ).toBe( '@@ Line 1 @@\n  intro\n- gone\n+ fresh\n  outro' );
	} );
} );
