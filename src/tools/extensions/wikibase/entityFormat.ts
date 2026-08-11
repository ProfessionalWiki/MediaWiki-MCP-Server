// Renders Wikibase statements as compact text. Entities routinely carry
// hundreds of statements and megabytes of JSON, so the tools never hand the raw
// entity to the caller: everything here reduces a claim group to one line.

/** Resolves an entity ID to a label, or undefined when it was not looked up. */
export type LabelLookup = (id: string) => string | undefined;

export interface Snak {
	snaktype: string;
	property: string;
	datatype?: string;
	datavalue?: { value: unknown; type: string };
}

export interface Statement {
	mainsnak: Snak;
	rank?: string;
	qualifiers?: Record<string, Snak[]>;
	references?: { snaks?: Record<string, Snak[]> }[];
}

export type Claims = Record<string, Statement[]>;

/** A property group whose values were cut, and the counts that explain the cut. */
export interface HiddenValues {
	propertyId: string;
	shown: number;
	total: number;
}

export interface RenderedClaims {
	lines: string[];
	/** Values the lines carry in all, across every property group. */
	shownValues: number;
	hidden: HiddenValues[];
}

export const MAX_PROPERTIES = 50;
export const MAX_VALUES_PER_PROPERTY = 10;

const MAX_VALUE_CHARS = 200;

/** Earth, the globe of all but a handful of coordinates, and not worth naming. */
const EARTH = 'Q2';

/** What Wikibase writes for a month or day the statement does not actually know. */
const UNKNOWN_PART = '00';

/** The calendar the dates of a Wikibase are read in unless a statement says otherwise. */
const GREGORIAN = 'Q1985727';

// Rank says which statements the community holds to be current: a property whose
// values changed over time keeps every one, with the preferred rank on the value
// that applies now. Wikibase returns them in edit order, so the current value is
// routinely last and would be the first thing a value cap dropped.
const RANK_ORDER: Readonly<Record<string, number>> = { preferred: 0, normal: 1, deprecated: 2 };

/**
 * The property groups a response renders, and how many the entity has. Applied
 * before anything else reads the claims, so that label resolution spends its
 * budget only on IDs that reach the caller.
 */
export function capProperties(
	claims: Claims,
	maxProperties: number,
): { claims: Claims; totalProperties: number } {
	const properties = Object.keys(claims);
	if (properties.length <= maxProperties) {
		return { claims, totalProperties: properties.length };
	}
	const capped: Claims = {};
	for (const propertyId of properties.slice(0, maxProperties)) {
		capped[propertyId] = claims[propertyId];
	}
	return { claims: capped, totalProperties: properties.length };
}

export function renderClaims(
	claims: Claims,
	labelFor: LabelLookup,
	maxValuesPerProperty: number,
): RenderedClaims {
	const lines: string[] = [];
	const hidden: HiddenValues[] = [];
	let shownValues = 0;
	for (const propertyId of Object.keys(claims)) {
		const statements = claims[propertyId];
		const shown = shownStatements(statements, maxValuesPerProperty);
		lines.push(renderPropertyGroup(propertyId, shown, statements.length, labelFor));
		shownValues += shown.length;
		if (shown.length < statements.length) {
			hidden.push({ propertyId, shown: shown.length, total: statements.length });
		}
	}
	return { lines, shownValues, hidden };
}

/** The statements of one property group that a rendering shows, in the order it shows them. */
function shownStatements(statements: Statement[], maxValues: number): Statement[] {
	return [...statements].sort((a, b) => rankOrder(a) - rankOrder(b)).slice(0, maxValues);
}

// An unknown rank sorts as normal. The lookup has to be an own-property one: a
// rank like 'toString' otherwise reads back as an inherited function.
function rankOrder(statement: Statement): number {
	const rank = statement.rank ?? 'normal';
	return Object.hasOwn(RANK_ORDER, rank) ? RANK_ORDER[rank] : RANK_ORDER.normal;
}

function renderPropertyGroup(
	propertyId: string,
	shown: Statement[],
	total: number,
	labelFor: LabelLookup,
): string {
	const values = shown.map((statement) => renderStatement(statement, labelFor)).join('; ');
	const hidden = total - shown.length;
	const overflow = hidden > 0 ? ` … +${hidden} more value${hidden === 1 ? '' : 's'}` : '';
	return `${withLabel(propertyId, labelFor(propertyId))}: ${values}${overflow}`;
}

function renderStatement(statement: Statement, labelFor: LabelLookup): string {
	const value = formatSnak(statement.mainsnak, labelFor);
	const notes = statementNotes(statement);
	return notes.length > 0 ? `${value} [${notes.join(', ')}]` : value;
}

// Qualifiers and references are summarised by count only. Rendering them turns a
// one-line statement into a paragraph, and the caller who needs them can read
// the property on its own with the property filter.
function statementNotes(statement: Statement): string[] {
	const notes: string[] = [];
	if (statement.rank === 'preferred' || statement.rank === 'deprecated') {
		notes.push(statement.rank);
	}
	const qualifiers = Object.values(statement.qualifiers ?? {}).reduce(
		(total, snaks) => total + snaks.length,
		0,
	);
	if (qualifiers > 0) {
		notes.push(`+${qualifiers} qualifier${qualifiers === 1 ? '' : 's'}`);
	}
	const references = statement.references?.length ?? 0;
	if (references > 0) {
		notes.push(`${references} reference${references === 1 ? '' : 's'}`);
	}
	return notes;
}

export function formatSnak(snak: Snak, labelFor: LabelLookup): string {
	if (snak.snaktype === 'novalue') {
		return '(no value)';
	}
	if (snak.snaktype !== 'value' || snak.datavalue === undefined) {
		return '(unknown value)';
	}

	const { value, type } = snak.datavalue;
	// Branching on the datavalue type rather than the property datatype: the
	// value types are the fixed core set, while datatypes are extensible, so a
	// custom string-backed datatype still renders as its string.
	switch (type) {
		case 'wikibase-entityid':
			return formatEntityIdValue(value, labelFor);
		case 'time':
			return formatTimeValue(value, labelFor);
		case 'quantity':
			return formatQuantityValue(value, labelFor);
		case 'monolingualtext':
			return formatMonolingualValue(value);
		case 'globecoordinate':
			return formatCoordinateValue(value, labelFor);
		default:
			return typeof value === 'string' ? clamp(value) : compactJson(value);
	}
}

/**
 * Every entity ID a rendering of these claims refers to, property IDs first so
 * that a batch capped below the total still resolves the line labels. Takes the
 * value limit the rendering uses, since an ID in a statement the cap hides costs
 * a lookup slot and reaches no one.
 */
export function referencedEntityIds(claims: Claims, maxValuesPerProperty: number): string[] {
	const ids: string[] = Object.keys(claims);
	for (const statements of Object.values(claims)) {
		for (const statement of shownStatements(statements, maxValuesPerProperty)) {
			const id = valueEntityId(statement.mainsnak);
			if (id !== undefined) {
				ids.push(id);
			}
		}
	}
	return [...new Set(ids)];
}

function valueEntityId(snak: Snak): string | undefined {
	if (snak.snaktype !== 'value' || snak.datavalue === undefined) {
		return undefined;
	}
	const { value, type } = snak.datavalue;
	if (type === 'wikibase-entityid') {
		return entityIdOf(value);
	}
	if (type === 'quantity' && isRecord(value)) {
		return quantityUnitId(value);
	}
	if (type === 'globecoordinate' && isRecord(value)) {
		return globeEntityId(value);
	}
	if (type === 'time' && isRecord(value)) {
		return calendarEntityId(value);
	}
	return undefined;
}

/** The calendar ID a rendering of this time will show, when one is worth a label. */
function calendarEntityId(value: Record<string, unknown>): string | undefined {
	if (typeof value.time !== 'string') {
		return undefined;
	}
	const parts = /^([+-])(\d+)-(\d{2})-(\d{2})T/.exec(value.time);
	if (parts === null) {
		return undefined;
	}
	const precision = typeof value.precision === 'number' ? value.precision : 11;
	const model = calendarModelOf(value, parts[3], precision);
	// A raw URI renders as itself, so it has no label to spend a lookup slot on.
	return model !== undefined && /^[A-Za-z]+\d+$/.test(model) ? model : undefined;
}

function formatEntityIdValue(value: unknown, labelFor: LabelLookup): string {
	const id = entityIdOf(value);
	return id === undefined ? compactJson(value) : withLabel(id, labelFor(id));
}

function entityIdOf(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (typeof value.id === 'string') {
		return value.id;
	}
	// Pre-2015 serialisations omit `id` and carry only the numeric part.
	if (typeof value['numeric-id'] === 'number') {
		return `${value['entity-type'] === 'property' ? 'P' : 'Q'}${value['numeric-id']}`;
	}
	return undefined;
}

/**
 * The entity ID of a bare ID or of a Wikibase concept URI, whose last two path
 * segments are `entity` and the ID. Anything else is undefined: a unit URI from
 * another vocabulary can end in letters and digits without naming an entity, and
 * an ID that names nothing fails the whole label batch it joins.
 */
function conceptUriId(uri: string): string | undefined {
	return /^[A-Za-z]+\d+$/.test(uri) ? uri : /\/entity\/([A-Za-z]+\d+)$/.exec(uri)?.[1];
}

// Wikibase writes the dimensionless unit as '1'; some serialisations leave it empty.
function isDimensionless(unit: string): boolean {
	return unit === '' || unit === '1';
}

function quantityUnitId(value: Record<string, unknown>): string | undefined {
	if (typeof value.unit !== 'string' || isDimensionless(value.unit)) {
		return undefined;
	}
	return conceptUriId(value.unit);
}

function globeEntityId(value: Record<string, unknown>): string | undefined {
	if (typeof value.globe !== 'string' || value.globe === '') {
		return undefined;
	}
	const id = conceptUriId(value.globe);
	return id === EARTH ? undefined : id;
}

function formatTimeValue(value: unknown, labelFor: LabelLookup): string {
	if (!isRecord(value) || typeof value.time !== 'string') {
		return compactJson(value);
	}
	const parts = /^([+-])(\d+)-(\d{2})-(\d{2})T/.exec(value.time);
	if (parts === null) {
		return value.time;
	}
	const [, sign, year, month, day] = parts;
	const precision = typeof value.precision === 'number' ? value.precision : 11;
	const date = formatTimePeriod(year, month, day, precision);
	const dated = sign === '-' ? `${date} BCE` : date;
	const calendar = calendarModelOf(value, month, precision);
	if (calendar === undefined) {
		return dated;
	}
	return `${dated} (${labelFor(calendar) ?? calendar})`;
}

/**
 * The calendar a rendered date has to name, or undefined when it does not.
 *
 * Julian and Gregorian dates diverge by up to thirteen days, so the same
 * statement means a different day under each. That only shows once a month is
 * rendered; at year precision and coarser the two agree on everything printed,
 * and naming the calendar there would mark most pre-1582 dates for nothing.
 * Gregorian is left unsaid, as the calendar the numbers are read in by default.
 */
function calendarModelOf(
	value: Record<string, unknown>,
	month: string,
	precision: number,
): string | undefined {
	if (precision < 10 || month === UNKNOWN_PART) {
		return undefined;
	}
	if (typeof value.calendarmodel !== 'string' || value.calendarmodel === '') {
		return undefined;
	}
	const id = conceptUriId(value.calendarmodel);
	if (id === GREGORIAN) {
		return undefined;
	}
	// A calendar URI from another vocabulary carries no entity ID. Naming it raw
	// beats dropping it, which would leave the date reading as Gregorian.
	return id ?? clamp(value.calendarmodel);
}

// Wikibase records how far a date is actually known, and everything below year
// precision is a period rather than a date: rendering the stored year alone
// turns "some time in the 1540s" into the claim that it was 1542. A statement can
// also claim a precision finer than the parts it filled in, so each band asks for
// the parts it needs rather than trusting the number.
function formatTimePeriod(year: string, month: string, day: string, precision: number): string {
	if (precision >= 11 && month !== UNKNOWN_PART && day !== UNKNOWN_PART) {
		return `${year}-${month}-${day}`;
	}
	if (precision >= 10 && month !== UNKNOWN_PART) {
		return `${year}-${month}`;
	}
	// Below the calendar bands a year is a number rather than part of a date, so
	// the ISO padding Wikibase stores it with goes.
	const numericYear = Number(year);
	if (precision >= 9) {
		return `${numericYear}`;
	}
	if (precision === 8) {
		return `${Math.floor(numericYear / 10) * 10}s`;
	}
	if (precision === 7) {
		return `${ordinal(Math.ceil(numericYear / 100))} century`;
	}
	if (precision === 6) {
		return `${ordinal(Math.ceil(numericYear / 1000))} millennium`;
	}
	return `c. ${numericYear}`;
}

function ordinal(value: number): string {
	const teens = value % 100;
	if (teens >= 11 && teens <= 13) {
		return `${value}th`;
	}
	switch (value % 10) {
		case 1:
			return `${value}st`;
		case 2:
			return `${value}nd`;
		case 3:
			return `${value}rd`;
		default:
			return `${value}th`;
	}
}

function formatQuantityValue(value: unknown, labelFor: LabelLookup): string {
	if (!isRecord(value) || typeof value.amount !== 'string') {
		return compactJson(value);
	}
	const amount = value.amount.replace(/^\+/, '');
	if (typeof value.unit !== 'string' || isDimensionless(value.unit)) {
		return amount;
	}
	const unitId = conceptUriId(value.unit);
	// A unit URI from another vocabulary carries no entity ID. Naming it raw
	// beats dropping it, which would leave the amount reading as dimensionless.
	return unitId === undefined
		? `${amount} ${clamp(value.unit)}`
		: `${amount} ${withLabel(unitId, labelFor(unitId))}`;
}

function formatMonolingualValue(value: unknown): string {
	if (!isRecord(value) || typeof value.text !== 'string') {
		return compactJson(value);
	}
	const text = clamp(value.text);
	return typeof value.language === 'string' ? `"${text}" (${value.language})` : `"${text}"`;
}

function formatCoordinateValue(value: unknown, labelFor: LabelLookup): string {
	if (
		!isRecord(value) ||
		typeof value.latitude !== 'number' ||
		typeof value.longitude !== 'number'
	) {
		return compactJson(value);
	}
	const coordinates = `${value.latitude}, ${value.longitude}`;
	// Earth is left unsaid; anything else changes what the numbers mean.
	if (typeof value.globe !== 'string' || value.globe === '') {
		return coordinates;
	}
	const globeId = conceptUriId(value.globe);
	if (globeId === EARTH) {
		return coordinates;
	}
	// A globe URI from another vocabulary carries no entity ID. Naming it raw
	// beats dropping it, which would leave the coordinate reading as terrestrial.
	return globeId === undefined
		? `${coordinates} on ${clamp(value.globe)}`
		: `${coordinates} on ${withLabel(globeId, labelFor(globeId))}`;
}

function withLabel(id: string, label: string | undefined): string {
	return label === undefined || label === '' ? id : `${id} (${label})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// One value cannot be allowed to dominate the line it shares with the rest of
// its property group, however long the wiki lets it be. The budget counts code
// points rather than UTF-16 units, so a cut landing inside an astral character
// such as an emoji does not leave half of one behind.
function clamp(text: string): string {
	const characters = Array.from(text);
	return characters.length > MAX_VALUE_CHARS
		? `${characters.slice(0, MAX_VALUE_CHARS).join('')}…`
		: text;
}

// Datatypes this version has no rendering for still have to say something
// grounded, so the raw value survives as JSON, bounded on the same terms.
function compactJson(value: unknown): string {
	return clamp(JSON.stringify(value) ?? String(value));
}
