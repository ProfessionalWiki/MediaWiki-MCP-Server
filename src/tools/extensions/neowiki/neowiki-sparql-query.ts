import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { ClassifiedError } from '../../../errors/classifyError.ts';
import { sparqlResultsFrom, sparqlToolResult } from '../../../results/sparqlResults.ts';
import { neowikiRequest } from './neowikiRequest.ts';

const HARD_LIMIT = 1000;

/**
 * NeoWiki caps no rows of a SPARQL answer, so this is what stands between a
 * query without LIMIT and the server's heap.
 */
const MAX_RESULT_BYTES = 10 * 1024 * 1024;

const inputSchema = {
	query: z
		.string()
		.min(1)
		.describe('SPARQL 1.1 query. SELECT returns rows; ASK returns a boolean.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(HARD_LIMIT)
		.optional()
		.describe(
			`Maximum rows to return. Caps what is handed back, not what the store computes — add LIMIT to the query itself to spare it the work. Hard cap ${HARD_LIMIT}, which also applies when omitted.`,
		),
} as const;

export const neowikiSparqlQuery: Tool<typeof inputSchema> = {
	name: 'neowiki-sparql-query',
	description: `Runs a read-only SPARQL 1.1 SELECT or ASK query against the wiki's NeoWiki knowledge graph in its SPARQL store, and returns the solutions as rows, one line per solution with the cells joined by \` | \` in column order, or an ASK query's boolean. Enabled only when the wiki has NeoWiki installed; the query endpoint exists only where NeoWiki has a SPARQL store, and on a wiki with Neo4j instead, neowiki-cypher-query answers. CONSTRUCT and DESCRIBE are not supported.

Discover the data model with neowiki-list-schemas and neowiki-get-schema; the RDF below is NeoWiki's native projection of it.

RDF model:
- Every NeoWiki IRI is under the wiki's RDF base, its canonical server URL unless the wiki configures another, and no prefix is declared for you. A first query such as SELECT ?class WHERE { GRAPH ?g { ?s a ?class } } LIMIT 1 shows the base at the start of the class IRI it returns.
- Each wiki page is a named graph <base>/graph/native/page/<page ID>, and NeoWiki writes nothing to the default graph, though some stores answer from it with every named graph folded in. Put each pattern in a GRAPH block of its own rather than the whole query in one, since the patterns of one block match within one page. Graphs under <base>/graph/<Mapping>/ hold ontology projections in another vocabulary; filter on the graph IRI to keep to the native one.
- A Subject is <base>/entity/<Subject ID>, typed with its Schema's class <base>/schema/<Schema>, with its name as rdfs:label. Each Statement is one triple per value part, with the predicate <base>/prop/<Schema>/<Property>; spaces in a Schema or property name become underscores (Birth date → Birth_date), and characters such as / # ? are percent-encoded.
- Values: text and select as xsd:string (select values are option IDs, decoded with neowiki-get-schema), number as xsd:decimal or xsd:integer, boolean as xsd:boolean, date as xsd:date, dateTime as xsd:dateTime, url as an IRI, monolingualText as language-tagged literals.
- A relation is a direct triple from the Subject to the target Subject, and also a <base>/ontology/Relation node with neo:source, neo:target and neo:relationType, where neo: is <base>/ontology/.
- A page is <base>/page/<page ID>, a neo:Page with neo:pageName, neo:hasSubject, neo:mainSubject, neo:category, dcterms:created and dcterms:modified.

Limits: 30 s per query by default (300 s with the apihighlimits right); up to ${HARD_LIMIT} rows per call and ${MAX_RESULT_BYTES / (1024 * 1024)} MB of results, and the response body is truncated at 75000 bytes by default; add LIMIT and OFFSET to page beyond that. A malformed query returns the store's own message.

Example, on a wiki whose base is https://wiki.example:
  PREFIX neo-schema: <https://wiki.example/schema/>
  PREFIX Person: <https://wiki.example/prop/Person/>
  PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
  SELECT ?name ?born WHERE { GRAPH ?g { ?p a neo-schema:Person ; rdfs:label ?name ; Person:Birth_date ?born } } ORDER BY ?born LIMIT 10`,
	inputSchema,
	annotations: {
		title: 'Run NeoWiki SPARQL query',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'run NeoWiki SPARQL query',
	target: (a) => a.query,

	async handle({ query, limit }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const data = await neowikiRequest(mwn, {
			method: 'POST',
			path: '/query/sparql',
			body: { query },
			unavailable:
				'The wiki has no SPARQL store, which SPARQL queries need; where it has Neo4j, neowiki-cypher-query answers.',
			sizeCap: {
				bytes: MAX_RESULT_BYTES,
				exceeded: `The store returned more than ${MAX_RESULT_BYTES / (1024 * 1024)} MB of results. Add LIMIT to the query, or project fewer variables.`,
			},
		});

		const effectiveLimit = limit ?? HARD_LIMIT;
		const results = sparqlResultsFrom(data, effectiveLimit);
		if (results === null) {
			throw new ClassifiedError(
				'upstream_failure',
				'The SPARQL store returned a response that is not SPARQL JSON results.',
			);
		}

		return ctx.format.ok(sparqlToolResult(results, effectiveLimit, 'neowiki-sparql-query'));
	},
};
