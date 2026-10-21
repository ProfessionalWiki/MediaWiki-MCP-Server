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
	violations?: unknown[];
	subject?: SubjectData;
}

export function writeResult(
	data: SubjectWriteResponse,
	subjectId: string,
): { violations: unknown[]; subject?: ReturnType<typeof flattenSubject> } {
	return {
		violations: Array.isArray(data.violations) ? data.violations : [],
		...(data.subject !== undefined ? { subject: flattenSubject(data.subject, subjectId) } : {}),
	};
}
