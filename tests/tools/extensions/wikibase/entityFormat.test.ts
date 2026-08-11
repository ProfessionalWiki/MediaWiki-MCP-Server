import { describe, it, expect } from 'vitest';
import {
	capProperties,
	formatSnak,
	MAX_VALUES_PER_PROPERTY,
	referencedEntityIds,
	renderClaims,
	type Claims,
	type Snak,
} from '../../../../src/tools/extensions/wikibase/entityFormat.ts';

function valueSnak(property: string, value: unknown, type: string): Snak {
	return { snaktype: 'value', property, datavalue: { value, type } };
}

const noLabels = (): undefined => undefined;

const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';
const JULIAN = 'http://www.wikidata.org/entity/Q1985786';

describe('formatSnak', () => {
	it('renders an item value as id with its resolved label', () => {
		const snak = valueSnak('P106', { 'entity-type': 'item', id: 'Q36834' }, 'wikibase-entityid');

		expect(formatSnak(snak, (id) => (id === 'Q36834' ? 'composer' : undefined))).toBe(
			'Q36834 (composer)',
		);
	});

	it('renders an item value as a bare id when no label resolved', () => {
		const snak = valueSnak('P106', { 'entity-type': 'item', id: 'Q36834' }, 'wikibase-entityid');

		expect(formatSnak(snak, noLabels)).toBe('Q36834');
	});

	it('renders a pre-2015 item value that carries only its numeric id', () => {
		const snak = valueSnak(
			'P106',
			{ 'entity-type': 'item', 'numeric-id': 36834 },
			'wikibase-entityid',
		);

		expect(formatSnak(snak, (id) => (id === 'Q36834' ? 'composer' : undefined))).toBe(
			'Q36834 (composer)',
		);
	});

	it('renders a pre-2015 property value that carries only its numeric id', () => {
		const snak = valueSnak(
			'P1963',
			{ 'entity-type': 'property', 'numeric-id': 31 },
			'wikibase-entityid',
		);

		expect(formatSnak(snak, (id) => (id === 'P31' ? 'instance of' : undefined))).toBe(
			'P31 (instance of)',
		);
	});

	it('renders a day-precision time as a calendar date', () => {
		const snak = valueSnak(
			'P569',
			{ time: '+1952-03-11T00:00:00Z', precision: 11, calendarmodel: GREGORIAN },
			'time',
		);

		expect(formatSnak(snak, noLabels)).toBe('1952-03-11');
	});

	it('names a calendar that is not the Gregorian one the numbers are read in', () => {
		const snak = valueSnak(
			'P569',
			{ time: '+1542-03-15T00:00:00Z', precision: 11, calendarmodel: JULIAN },
			'time',
		);

		expect(formatSnak(snak, (id) => (id === 'Q1985786' ? 'Julian calendar' : undefined))).toBe(
			'1542-03-15 (Julian calendar)',
		);
	});

	it('names an unlabelled non-Gregorian calendar by its id', () => {
		const snak = valueSnak(
			'P569',
			{ time: '+1542-03-15T00:00:00Z', precision: 11, calendarmodel: JULIAN },
			'time',
		);

		expect(formatSnak(snak, noLabels)).toBe('1542-03-15 (Q1985786)');
	});

	// Julian and Gregorian diverge by days, which no rendering coarser than a
	// month shows, so marking one there would flag most pre-1582 dates for nothing.
	it('leaves the calendar unsaid when the rendering is too coarse to diverge', () => {
		const snak = valueSnak(
			'P569',
			{ time: '+1542-01-01T00:00:00Z', precision: 9, calendarmodel: JULIAN },
			'time',
		);

		expect(formatSnak(snak, noLabels)).toBe('1542');
	});

	it('leaves the calendar unsaid when a day-precision claim filled in no month', () => {
		const snak = valueSnak(
			'P569',
			{ time: '+1542-00-00T00:00:00Z', precision: 11, calendarmodel: JULIAN },
			'time',
		);

		expect(formatSnak(snak, noLabels)).toBe('1542');
	});

	it('names a calendar uri that is not an entity rather than dropping it', () => {
		const snak = valueSnak(
			'P569',
			{ time: '+1542-03-15T00:00:00Z', precision: 11, calendarmodel: 'http://example.org/cal/x' },
			'time',
		);

		expect(formatSnak(snak, noLabels)).toBe('1542-03-15 (http://example.org/cal/x)');
	});

	it('renders a year-precision time as the year alone', () => {
		const snak = valueSnak(
			'P571',
			{ time: '+1867-01-01T00:00:00Z', precision: 9, calendarmodel: GREGORIAN },
			'time',
		);

		expect(formatSnak(snak, noLabels)).toBe('1867');
	});

	it('renders a month-precision time as year and month', () => {
		const snak = valueSnak(
			'P571',
			{ time: '+1867-05-01T00:00:00Z', precision: 10, calendarmodel: GREGORIAN },
			'time',
		);

		expect(formatSnak(snak, noLabels)).toBe('1867-05');
	});

	// Wikibase writes an unknown month or day as '00', and does so whatever precision
	// the statement claims, so the stored parts decide the band rather than the number.
	it('renders a date whose month is unknown as the year alone', () => {
		const snak = valueSnak('P571', { time: '+1867-00-00T00:00:00Z', precision: 11 }, 'time');

		expect(formatSnak(snak, noLabels)).toBe('1867');
	});

	it('renders a date whose day is unknown as year and month', () => {
		const snak = valueSnak('P571', { time: '+1867-05-00T00:00:00Z', precision: 11 }, 'time');

		expect(formatSnak(snak, noLabels)).toBe('1867-05');
	});

	// Wikibase defines precisions finer than a day; this renderer deliberately stops there.
	it.each([12, 13, 14])('renders precision %i no finer than the day', (precision) => {
		const snak = valueSnak('P569', { time: '+1952-03-11T00:00:00Z', precision }, 'time');

		expect(formatSnak(snak, noLabels)).toBe('1952-03-11');
	});

	it('renders a decade-precision time as a decade, not the stored year', () => {
		const snak = valueSnak('P571', { time: '+1542-00-00T00:00:00Z', precision: 8 }, 'time');

		expect(formatSnak(snak, noLabels)).toBe('1540s');
	});

	it('renders a century-precision time as an ordinal century', () => {
		const snak = valueSnak('P571', { time: '+1501-00-00T00:00:00Z', precision: 7 }, 'time');

		expect(formatSnak(snak, noLabels)).toBe('16th century');
	});

	it('counts the last year of a century as that century', () => {
		const snak = valueSnak('P571', { time: '+1600-00-00T00:00:00Z', precision: 7 }, 'time');

		expect(formatSnak(snak, noLabels)).toBe('16th century');
	});

	// The ordinal suffix does not follow from the last digit alone: 11, 12 and 13
	// take 'th' where 1, 2 and 3 take 'st', 'nd' and 'rd'.
	it.each([
		['+0050', '1st century'],
		['+0150', '2nd century'],
		['+0250', '3rd century'],
		['+0350', '4th century'],
		['+1050', '11th century'],
		['+1150', '12th century'],
		['+1250', '13th century'],
		['+2050', '21st century'],
		['+2150', '22nd century'],
		['+2250', '23rd century'],
	])('renders year %s at century precision as the %s', (year, expected) => {
		const snak = valueSnak('P571', { time: `${year}-00-00T00:00:00Z`, precision: 7 }, 'time');

		expect(formatSnak(snak, noLabels)).toBe(expected);
	});

	it('renders a millennium-precision time as an ordinal millennium', () => {
		const snak = valueSnak('P571', { time: '+1001-00-00T00:00:00Z', precision: 6 }, 'time');

		expect(formatSnak(snak, noLabels)).toBe('2nd millennium');
	});

	it.each([
		['+0500', '1st millennium'],
		['+2500', '3rd millennium'],
	])('renders year %s at millennium precision as the %s', (year, expected) => {
		const snak = valueSnak('P571', { time: `${year}-00-00T00:00:00Z`, precision: 6 }, 'time');

		expect(formatSnak(snak, noLabels)).toBe(expected);
	});

	it('marks a coarse date as approximate rather than naming a year', () => {
		const snak = valueSnak('P580', { time: '+0900-00-00T00:00:00Z', precision: 5 }, 'time');

		expect(formatSnak(snak, noLabels)).toBe('c. 900');
	});

	it('marks a negative century as BCE', () => {
		const snak = valueSnak('P571', { time: '-0500-00-00T00:00:00Z', precision: 7 }, 'time');

		expect(formatSnak(snak, noLabels)).toBe('5th century BCE');
	});

	// Wikibase stores years ISO-padded. A year on its own is a number and reads as
	// one; a calendar date keeps the padding it is written with.
	it('drops the stored padding from a bce year', () => {
		const snak = valueSnak('P569', { time: '-0100-07-12T00:00:00Z', precision: 9 }, 'time');

		expect(formatSnak(snak, noLabels)).toBe('100 BCE');
	});

	it('keeps the padding of a bce year and month', () => {
		const snak = valueSnak('P570', { time: '-0044-03-00T00:00:00Z', precision: 10 }, 'time');

		expect(formatSnak(snak, noLabels)).toBe('0044-03 BCE');
	});

	it('keeps the padding of a bce calendar date', () => {
		const snak = valueSnak(
			'P570',
			{ time: '-0044-03-15T00:00:00Z', precision: 11, calendarmodel: GREGORIAN },
			'time',
		);

		expect(formatSnak(snak, noLabels)).toBe('0044-03-15 BCE');
	});

	it('renders a quantity with its unit id and label', () => {
		const snak = valueSnak(
			'P2048',
			{ amount: '+1.96', unit: 'http://www.wikidata.org/entity/Q11573' },
			'quantity',
		);

		expect(formatSnak(snak, (id) => (id === 'Q11573' ? 'metre' : undefined))).toBe(
			'1.96 Q11573 (metre)',
		);
	});

	it('renders a dimensionless quantity as the amount alone', () => {
		const snak = valueSnak('P1082', { amount: '+8000000', unit: '1' }, 'quantity');

		expect(formatSnak(snak, noLabels)).toBe('8000000');
	});

	it('renders monolingual text with its language', () => {
		const snak = valueSnak('P1813', { text: 'Douglas Adams', language: 'en' }, 'monolingualtext');

		expect(formatSnak(snak, noLabels)).toBe('"Douglas Adams" (en)');
	});

	it('renders a globe coordinate as latitude and longitude', () => {
		const snak = valueSnak(
			'P625',
			{
				latitude: 52.5163,
				longitude: 13.3777,
				precision: 0.0001,
				globe: 'http://www.wikidata.org/entity/Q2',
			},
			'globecoordinate',
		);

		expect(formatSnak(snak, noLabels)).toBe('52.5163, 13.3777');
	});

	it('names a unit that is not an entity rather than dropping it', () => {
		const snak = valueSnak(
			'P2048',
			{ amount: '+1.96', unit: 'http://qudt.org/vocab/unit/M' },
			'quantity',
		);

		expect(formatSnak(snak, noLabels)).toBe('1.96 http://qudt.org/vocab/unit/M');
	});

	it('names a foreign unit whose uri ends in an entity-shaped segment', () => {
		const snak = valueSnak(
			'P2048',
			{ amount: '+1.96', unit: 'http://qudt.org/vocab/unit/M3' },
			'quantity',
		);

		expect(formatSnak(snak, noLabels)).toBe('1.96 http://qudt.org/vocab/unit/M3');
	});

	it('names the globe of a coordinate that is not on Earth', () => {
		const snak = valueSnak(
			'P625',
			{ latitude: -14.5, longitude: 175.4, globe: 'http://www.wikidata.org/entity/Q111' },
			'globecoordinate',
		);

		expect(formatSnak(snak, (id) => (id === 'Q111' ? 'Mars' : undefined))).toBe(
			'-14.5, 175.4 on Q111 (Mars)',
		);
	});

	it('names a globe that is not an entity rather than dropping it', () => {
		const snak = valueSnak(
			'P625',
			{ latitude: 18.65, longitude: 226.2, globe: 'http://example.org/globes/mars' },
			'globecoordinate',
		);

		expect(formatSnak(snak, noLabels)).toBe('18.65, 226.2 on http://example.org/globes/mars');
	});

	it('clamps a globe uri that would dominate its line', () => {
		const globe = `http://example.org/globes/${'m'.repeat(400)}`;
		const snak = valueSnak('P625', { latitude: 1, longitude: 2, globe }, 'globecoordinate');

		expect(formatSnak(snak, noLabels)).toBe(`1, 2 on ${Array.from(globe).slice(0, 200).join('')}…`);
	});

	it('clamps a string value that would dominate its line', () => {
		const snak = valueSnak('P373', 'x'.repeat(600), 'string');

		expect(formatSnak(snak, noLabels)).toBe(`${'x'.repeat(200)}…`);
	});

	// Cutting UTF-16 units instead of characters leaves half an astral character
	// behind, which is not text any more.
	it('clamps without splitting a character that straddles the limit', () => {
		const snak = valueSnak('P373', `${'x'.repeat(199)}😀${'y'.repeat(100)}`, 'string');

		expect(formatSnak(snak, noLabels)).toBe(`${'x'.repeat(199)}😀…`);
	});

	it('clamps monolingual text and keeps its language', () => {
		const snak = valueSnak('P1476', { text: 'y'.repeat(600), language: 'en' }, 'monolingualtext');

		expect(formatSnak(snak, noLabels)).toBe(`"${'y'.repeat(200)}…" (en)`);
	});

	it('renders an external id verbatim', () => {
		const snak = valueSnak('P1015', '90196888', 'string');

		expect(formatSnak(snak, noLabels)).toBe('90196888');
	});

	it('renders a url verbatim', () => {
		const snak = valueSnak('P856', 'https://douglasadams.com', 'string');

		expect(formatSnak(snak, noLabels)).toBe('https://douglasadams.com');
	});

	it('renders a string verbatim', () => {
		const snak = valueSnak('P373', 'Douglas Adams', 'string');

		expect(formatSnak(snak, noLabels)).toBe('Douglas Adams');
	});

	it('names an unknown value snak', () => {
		expect(formatSnak({ snaktype: 'somevalue', property: 'P570' }, noLabels)).toBe(
			'(unknown value)',
		);
	});

	it('names a no value snak', () => {
		expect(formatSnak({ snaktype: 'novalue', property: 'P40' }, noLabels)).toBe('(no value)');
	});

	it('falls back to compact JSON for an unrecognised datatype', () => {
		const snak = valueSnak('P9999', { some: 'shape' }, 'future');

		expect(formatSnak(snak, noLabels)).toBe('{"some":"shape"}');
	});
});

describe('referencedEntityIds', () => {
	it('lists property ids before value ids so property labels win a truncated batch', () => {
		const claims: Claims = {
			P31: [
				{
					mainsnak: valueSnak('P31', { 'entity-type': 'item', id: 'Q5' }, 'wikibase-entityid'),
				},
			],
			P106: [
				{
					mainsnak: valueSnak('P106', { 'entity-type': 'item', id: 'Q36834' }, 'wikibase-entityid'),
				},
			],
		};

		expect(referencedEntityIds(claims, MAX_VALUES_PER_PROPERTY)).toEqual([
			'P31',
			'P106',
			'Q5',
			'Q36834',
		]);
	});

	it('looks up the label of a pre-2015 value that carries only its numeric id', () => {
		const claims: Claims = {
			P106: [
				{
					mainsnak: valueSnak(
						'P106',
						{ 'entity-type': 'item', 'numeric-id': 36834 },
						'wikibase-entityid',
					),
				},
			],
		};

		expect(referencedEntityIds(claims, MAX_VALUES_PER_PROPERTY)).toEqual(['P106', 'Q36834']);
	});

	it('includes quantity units and de-duplicates repeated ids', () => {
		const claims: Claims = {
			P2044: [
				{
					mainsnak: valueSnak(
						'P2044',
						{ amount: '+5', unit: 'http://www.wikidata.org/entity/Q11573' },
						'quantity',
					),
				},
				{
					mainsnak: valueSnak(
						'P2044',
						{ amount: '+7', unit: 'http://www.wikidata.org/entity/Q11573' },
						'quantity',
					),
				},
			],
		};

		expect(referencedEntityIds(claims, MAX_VALUES_PER_PROPERTY)).toEqual(['P2044', 'Q11573']);
	});

	// An id that names no entity fails the whole wbgetentities batch it joins, so a
	// unit URI from another vocabulary must not be guessed at.
	it('leaves a foreign unit uri out of the ids to look up', () => {
		const claims: Claims = {
			P2048: [
				{
					mainsnak: valueSnak(
						'P2048',
						{ amount: '+1.96', unit: 'http://qudt.org/vocab/unit/M3' },
						'quantity',
					),
				},
			],
		};

		expect(referencedEntityIds(claims, MAX_VALUES_PER_PROPERTY)).toEqual(['P2048']);
	});

	it('ignores literal values that carry no entity id', () => {
		const claims: Claims = {
			P373: [{ mainsnak: valueSnak('P373', 'Douglas Adams', 'string') }],
		};

		expect(referencedEntityIds(claims, MAX_VALUES_PER_PROPERTY)).toEqual(['P373']);
	});

	it('collects only from the statements the value limit renders', () => {
		const claims: Claims = {
			P106: Array.from({ length: 4 }, (_, i) => ({
				mainsnak: valueSnak('P106', { 'entity-type': 'item', id: `Q${i}` }, 'wikibase-entityid'),
			})),
		};

		expect(referencedEntityIds(claims, 2)).toEqual(['P106', 'Q0', 'Q1']);
	});

	it('collects from the preferred statement the value limit keeps', () => {
		const claims: Claims = {
			P1082: [
				{
					mainsnak: valueSnak('P1082', { 'entity-type': 'item', id: 'Q1' }, 'wikibase-entityid'),
					rank: 'normal',
				},
				{
					mainsnak: valueSnak('P1082', { 'entity-type': 'item', id: 'Q2' }, 'wikibase-entityid'),
					rank: 'preferred',
				},
			],
		};

		expect(referencedEntityIds(claims, 1)).toEqual(['P1082', 'Q2']);
	});

	it('looks up the label of a calendar the date has to name', () => {
		const claims: Claims = {
			P569: [
				{
					mainsnak: valueSnak(
						'P569',
						{ time: '+1542-03-15T00:00:00Z', precision: 11, calendarmodel: JULIAN },
						'time',
					),
				},
			],
		};

		expect(referencedEntityIds(claims, MAX_VALUES_PER_PROPERTY)).toContain('Q1985786');
	});

	it('leaves a calendar the date does not name out of the ids to look up', () => {
		const claims: Claims = {
			P569: [
				{
					mainsnak: valueSnak(
						'P569',
						{ time: '+1542-00-00T00:00:00Z', precision: 9, calendarmodel: JULIAN },
						'time',
					),
				},
			],
		};

		expect(referencedEntityIds(claims, MAX_VALUES_PER_PROPERTY)).not.toContain('Q1985786');
	});

	it('leaves a foreign globe uri out of the ids to look up', () => {
		const claims: Claims = {
			P625: [
				{
					mainsnak: valueSnak(
						'P625',
						{ latitude: 18.65, longitude: 226.2, globe: 'http://example.org/globes/mars' },
						'globecoordinate',
					),
				},
			],
		};

		expect(referencedEntityIds(claims, MAX_VALUES_PER_PROPERTY)).toEqual(['P625']);
	});

	it('includes the globe of a coordinate away from Earth', () => {
		const claims: Claims = {
			P625: [
				{
					mainsnak: valueSnak(
						'P625',
						{ latitude: 1, longitude: 2, globe: 'http://www.wikidata.org/entity/Q111' },
						'globecoordinate',
					),
				},
			],
		};

		expect(referencedEntityIds(claims, MAX_VALUES_PER_PROPERTY)).toEqual(['P625', 'Q111']);
	});
});

describe('renderClaims', () => {
	const claims: Claims = {
		P31: [
			{
				mainsnak: valueSnak('P31', { 'entity-type': 'item', id: 'Q5' }, 'wikibase-entityid'),
			},
		],
		P106: [
			{
				mainsnak: valueSnak('P106', { 'entity-type': 'item', id: 'Q36834' }, 'wikibase-entityid'),
			},
			{
				mainsnak: valueSnak('P106', { 'entity-type': 'item', id: 'Q214917' }, 'wikibase-entityid'),
			},
		],
	};

	const labels: Record<string, string> = {
		P31: 'instance of',
		P106: 'occupation',
		Q5: 'human',
		Q36834: 'composer',
		Q214917: 'playwright',
	};
	const labelFor = (id: string): string | undefined => labels[id];

	// Wikibase returns statements in edit order, so the rank that says which value
	// applies now is routinely on the last one.
	const rankedOccupations: Claims = {
		P106: [
			{ mainsnak: claims.P106[0].mainsnak, rank: 'normal' },
			{ mainsnak: claims.P31[0].mainsnak, rank: 'deprecated' },
			{ mainsnak: claims.P106[1].mainsnak, rank: 'preferred' },
		],
	};

	it('renders one line per property, values separated by semicolons', () => {
		const { lines } = renderClaims(claims, labelFor, MAX_VALUES_PER_PROPERTY);

		expect(lines).toEqual([
			'P31 (instance of): Q5 (human)',
			'P106 (occupation): Q36834 (composer); Q214917 (playwright)',
		]);
	});

	it('appends a terse qualifier and reference count when the statement has them', () => {
		const withExtras: Claims = {
			P31: [
				{
					mainsnak: claims.P31[0].mainsnak,
					qualifiers: { P580: [{ snaktype: 'somevalue', property: 'P580' }] },
					references: [{ snaks: {} }, { snaks: {} }],
				},
			],
		};

		const { lines } = renderClaims(withExtras, labelFor, MAX_VALUES_PER_PROPERTY);

		expect(lines).toEqual(['P31 (instance of): Q5 (human) [+1 qualifier, 2 references]']);
	});

	it('marks a deprecated statement', () => {
		const deprecated: Claims = {
			P31: [{ mainsnak: claims.P31[0].mainsnak, rank: 'deprecated' }],
		};

		const { lines } = renderClaims(deprecated, labelFor, MAX_VALUES_PER_PROPERTY);

		expect(lines).toEqual(['P31 (instance of): Q5 (human) [deprecated]']);
	});

	it('marks a preferred statement', () => {
		const preferred: Claims = {
			P31: [{ mainsnak: claims.P31[0].mainsnak, rank: 'preferred' }],
		};

		const { lines } = renderClaims(preferred, labelFor, MAX_VALUES_PER_PROPERTY);

		expect(lines).toEqual(['P31 (instance of): Q5 (human) [preferred]']);
	});

	it('shows the preferred value first however late the wiki stores it', () => {
		const { lines } = renderClaims(rankedOccupations, labelFor, MAX_VALUES_PER_PROPERTY);

		expect(lines).toEqual([
			'P106 (occupation): Q214917 (playwright) [preferred]; Q36834 (composer); Q5 (human) [deprecated]',
		]);
	});

	// A rank naming a member of Object's prototype reads back as a function rather
	// than undefined, which would sort the whole group on NaN.
	it('treats a rank that is only inherited as normal', () => {
		const inheritedRank: Claims = {
			P106: [
				{ mainsnak: claims.P106[0].mainsnak, rank: 'toString' },
				{ mainsnak: claims.P106[1].mainsnak, rank: 'preferred' },
			],
		};

		const { lines } = renderClaims(inheritedRank, labelFor, MAX_VALUES_PER_PROPERTY);

		expect(lines).toEqual([
			'P106 (occupation): Q214917 (playwright) [preferred]; Q36834 (composer)',
		]);
	});

	it('keeps the preferred value when the value cap drops the rest', () => {
		const { lines } = renderClaims(rankedOccupations, labelFor, 1);

		expect(lines).toEqual(['P106 (occupation): Q214917 (playwright) [preferred] … +2 more values']);
	});

	it('caps the values shown for one property and counts the remainder', () => {
		const { lines } = renderClaims(claims, labelFor, 1);

		expect(lines).toEqual([
			'P31 (instance of): Q5 (human)',
			'P106 (occupation): Q36834 (composer) … +1 more value',
		]);
	});

	it('reports which property hid values and how many it holds', () => {
		const { hidden } = renderClaims(claims, labelFor, 1);

		expect(hidden).toEqual([{ propertyId: 'P106', shown: 1, total: 2 }]);
	});

	it('reports no hidden values when every value fits', () => {
		const { hidden } = renderClaims(claims, labelFor, MAX_VALUES_PER_PROPERTY);

		expect(hidden).toEqual([]);
	});
});

describe('capProperties', () => {
	const claims: Claims = {
		P31: [{ mainsnak: valueSnak('P31', 'a', 'string') }],
		P106: [{ mainsnak: valueSnak('P106', 'b', 'string') }],
	};

	it('keeps the first properties and reports how many the entity has', () => {
		const capped = capProperties(claims, 1);

		expect(Object.keys(capped.claims)).toEqual(['P31']);
		expect(capped.totalProperties).toBe(2);
	});

	it('leaves a claim set within the cap untouched', () => {
		const capped = capProperties(claims, 5);

		expect(capped.claims).toBe(claims);
		expect(capped.totalProperties).toBe(2);
	});
});
