import { z } from 'zod';
import { statementsSchema } from './statements.ts';

export const baseRevisionIdSchema = z
	.number()
	.int()
	.positive()
	.describe(
		'Revision ID the change was made from: the revisionId of the neowiki-get-subject read, or of the write, that returned the Subject being changed. A later revision ID makes the write overwrite the changes made after that read.',
	);

export const CONTROLLED_SUBJECT_RIGHTS =
	'Requires the edit right, and for a Controlled Subject, of a Schema with subjectsAreControlled in neowiki-get-schema, the neowiki-controlled-subject-edit right too.';

export const WRITE_VALIDATION =
	'A write that breaks a rule for Dependent Subjects is refused; other violations are warnings unless the wiki enforces validation, which refuses a write that introduces an error-severity one.';

export const STATEMENT_EDIT_CONFLICT =
	'Where the Statement, or a Dependent Subject it reaches, changed after baseRevisionId, the write is refused as an edit conflict and writes nothing, and neowiki-get-subject returns the Subject as it now is, with the revisionId to base a new write on.';

export const WRITE_RESULT =
	'Returns the revision ID the page is at after the write as revisionId, the violations of its Schema the Subject was saved with, and the Subject as saved.';

interface StatementJson {
	propertyType: string;
	value: unknown;
}

/** A Subject as NeoWiki serves it. */
export interface SubjectJson {
	id: string;
	label: string | null;
	displayName: string;
	schema: string;
	hostSubject?: unknown;
	pageId?: number;
	pageTitle?: string;
	statements: Record<string, StatementJson>;
}

/** A Subject as the read tools return it: NeoWiki's, with "" for no label, which the write tools take back. */
export interface ReadSubject extends Omit<SubjectJson, 'label'> {
	label: string;
}

export function presentSubject(subject: SubjectJson): ReadSubject {
	return {
		id: subject.id,
		label: subject.label ?? '',
		displayName: subject.displayName,
		schema: subject.schema,
		...(subject.hostSubject !== undefined ? { hostSubject: subject.hostSubject } : {}),
		...(subject.pageId !== undefined ? { pageId: subject.pageId } : {}),
		...(subject.pageTitle !== undefined ? { pageTitle: subject.pageTitle } : {}),
		statements: subject.statements,
	};
}

export interface SubjectWriteResponse {
	status: string;
	subjectId: string;
	/** Absent before ProfessionalWiki/NeoWiki#1870. */
	revisionId?: number;
	/** Absent from NeoWiki that predates write violations. */
	violations?: unknown[];
	subject?: SubjectJson;
}

/** A Subject write's result: NeoWiki's answer, with the Subject as saved as the read tools return it. */
export function writeResult(data: SubjectWriteResponse): {
	subjectId: string;
	status: string;
	revisionId?: number;
	violations: unknown[];
	subject?: ReadSubject;
} {
	return {
		subjectId: data.subjectId,
		status: data.status,
		...(data.revisionId !== undefined ? { revisionId: data.revisionId } : {}),
		violations: data.violations ?? [],
		...(data.subject !== undefined ? { subject: presentSubject(data.subject) } : {}),
	};
}

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
