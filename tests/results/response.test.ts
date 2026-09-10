import { describe, it, expect } from 'vitest';
import { ResponseFormatterImpl } from '../../src/results/response.ts';

describe('ResponseFormatterImpl', () => {
	const fmt = new ResponseFormatterImpl();

	it('ok produces a content block with markdown text', () => {
		const result = fmt.ok({ title: 'Foo', size: 5 });
		expect(result.isError).toBeUndefined();
		expect(result.content).toHaveLength(1);
		expect((result.content![0] as { type: string; text: string }).text).toContain('Title:');
		expect((result.content![0] as { type: string; text: string }).text).toContain('Foo');
	});

	it('error produces an isError result with JSON envelope', () => {
		const result = fmt.error('not_found', 'Page X not found', 'missingtitle');
		expect(result.isError).toBe(true);
		const envelope = JSON.parse((result.content![0] as { text: string }).text);
		expect(envelope).toEqual({
			category: 'not_found',
			message: 'Page X not found',
			code: 'missingtitle',
		});
	});

	it('error omits code when undefined', () => {
		const result = fmt.error('invalid_input', 'Bad');
		const envelope = JSON.parse((result.content![0] as { text: string }).text);
		expect(envelope).toEqual({ category: 'invalid_input', message: 'Bad' });
	});

	it('notFound is a typed shorthand for error("not_found", ...)', () => {
		expect(fmt.notFound('X', 'missingtitle')).toEqual(fmt.error('not_found', 'X', 'missingtitle'));
	});

	it('invalidInput is a typed shorthand for error("invalid_input", ...)', () => {
		expect(fmt.invalidInput('Bad')).toEqual(fmt.error('invalid_input', 'Bad'));
	});

	it('conflict is a typed shorthand for error("conflict", ...)', () => {
		expect(fmt.conflict('X', 'editconflict')).toEqual(fmt.error('conflict', 'X', 'editconflict'));
	});

	it('permissionDenied is a typed shorthand for error("permission_denied", ...)', () => {
		expect(fmt.permissionDenied('X', 'protectedpage')).toEqual(
			fmt.error('permission_denied', 'X', 'protectedpage'),
		);
	});
});
