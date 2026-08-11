import type { ErrorCategory } from '../../../errors/classifyError.ts';

/**
 * The error codes Wikibase's action modules add to the action API's vocabulary.
 *
 * These reach the caller through the central classifier rather than through this
 * pack, because a tool that requests through mwn never catches its own error:
 * mwn throws and the dispatcher classifies. The SPARQL tool is the exception —
 * it has its own transport, so `SparqlError` carries its category directly.
 */
export const WIKIBASE_ERROR_CODES: Readonly<Record<string, ErrorCategory>> = {
	// The requested entity ID does not exist on the wiki.
	'no-such-entity': 'not_found',
	// The ID is not in the wiki's entity-ID format.
	'invalid-entity-id': 'invalid_input',
	// A parameter is missing, malformed, or names something the entity does not
	// hold. `modification-failed` covers a change the entity itself refuses, such
	// as a duplicate term or a statement that already exists.
	'param-illegal': 'invalid_input',
	'param-missing': 'invalid_input',
	'invalid-snak': 'invalid_input',
	'no-such-claim': 'invalid_input',
	'not-recognized': 'invalid_input',
	'modification-failed': 'invalid_input',
	// The request describes a change the entity cannot apply: the data is absent,
	// a value is malformed, or a payload field contradicts the parameter sent
	// alongside it.
	'inconsistent-language': 'invalid_input',
	'inconsistent-site': 'invalid_input',
	'no-data': 'invalid_input',
	'param-invalid': 'invalid_input',
	'invalid-guid': 'invalid_input',
	'tags-invalid': 'invalid_input',
	'failed-modify': 'invalid_input',
};

/** Wikibase answers an unreadable JSON value with one code per shape it expected. */
export const WIKIBASE_ERROR_CODE_PREFIXES: readonly (readonly [RegExp, ErrorCategory])[] = [
	[/^not-recognized-/, 'invalid_input'],
];
