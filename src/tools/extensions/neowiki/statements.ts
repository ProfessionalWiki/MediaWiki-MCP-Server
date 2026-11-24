import { z } from 'zod';

export const VALUE_FORMATS =
	'text/url/date/dateTime → array of strings (date "2020-12-31", dateTime "2020-12-31T14:30:00Z", with Z or an offset); select → array of option IDs (resolve labels via neowiki-get-schema); number → a number; boolean → a boolean; relation → array of { target: "<subjectId>" }; monolingualText → array of { text, language }';

// NeoWiki before ProfessionalWiki/NeoWiki#1833 drops an entry without
// `propertyType` and saves the rest, so require it here.
const statementSchema = z.object({
	propertyType: z
		.string()
		.min(1)
		.describe("The property's type, as neowiki-get-subject returns it under propertyType."),
	value: z.unknown().describe(`Value shaped by propertyType: ${VALUE_FORMATS}.`),
});

export const statementsSchema = z.record(z.string(), statementSchema);

export const dependentSubjectsSchema = z.array(
	z.object({
		id: z
			.string()
			.min(1)
			.describe(
				'An unused Subject ID from neowiki-mint-subject-ids, creating the Dependent Subject, or the ID of a Dependent Subject this Subject reaches, replacing it.',
			),
		schema: z.string().min(1).describe('Name of a Schema whose Subjects are dependent.'),
		statements: statementsSchema.describe(
			"The Dependent Subject's statement map, shaped as for the Subject itself.",
		),
	}),
);
