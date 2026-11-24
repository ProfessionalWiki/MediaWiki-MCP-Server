import { z } from 'zod';

export const baseRevisionIdSchema = z
	.number()
	.int()
	.positive()
	.describe(
		'Revision ID the change was made from: the revisionId of the neowiki-get-subject read, or of the write, that returned the Subject being changed. A later revision ID makes the write overwrite the changes made after that read.',
	);

interface SubjectStatement {
	propertyType?: string;
	value?: unknown;
}

export interface SubjectData {
	id?: string;
	label?: string | null;
	displayName?: string;
	schema?: string;
	hostSubject?: unknown;
	pageId?: number;
	pageTitle?: string;
	statements?: Record<string, SubjectStatement>;
}

export function flattenSubject(
	subject: SubjectData,
	fallbackId: string,
): {
	id: string;
	label: string;
	displayName: string;
	schema: string;
	hostSubject?: unknown;
	pageId?: number;
	pageTitle?: string;
	statements: Array<{ property: string; type: string; value: unknown }>;
} {
	const statements = Object.entries(subject.statements ?? {}).map(([property, statement]) => ({
		property,
		type: typeof statement.propertyType === 'string' ? statement.propertyType : '',
		value: statement.value,
	}));
	return {
		id: subject.id ?? fallbackId,
		label: subject.label ?? '',
		displayName: subject.displayName ?? '',
		schema: subject.schema ?? '',
		...(subject.hostSubject !== undefined ? { hostSubject: subject.hostSubject } : {}),
		...(subject.pageId !== undefined ? { pageId: subject.pageId } : {}),
		...(subject.pageTitle !== undefined ? { pageTitle: subject.pageTitle } : {}),
		statements,
	};
}

export interface SubjectWriteResponse {
	status?: string;
	subjectId?: string;
	revisionId?: number;
	violations?: unknown[];
	subject?: SubjectData;
}

export function writeResult(
	data: SubjectWriteResponse,
	subjectId: string,
): { revisionId?: number; violations: unknown[]; subject?: ReturnType<typeof flattenSubject> } {
	return {
		...(typeof data.revisionId === 'number' ? { revisionId: data.revisionId } : {}),
		violations: Array.isArray(data.violations) ? data.violations : [],
		...(data.subject !== undefined ? { subject: flattenSubject(data.subject, subjectId) } : {}),
	};
}
