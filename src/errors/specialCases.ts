import type { ErrorCategory } from './classifyError.js';

export interface SpecialCaseResult {
	category: ErrorCategory;
	code: string;
	message: string;
}

export type SpecialCaseHandler = (
	err: unknown,
	toolName: string,
	classified: { category: ErrorCategory; code?: string }
) => SpecialCaseResult | null;

// Filled in Task 5; placeholder for now.
export function applySpecialCase(
	_toolName: string,
	classified: { category: ErrorCategory; code?: string },
	_err: unknown
): { category: ErrorCategory; code?: string; message: string } {
	return { ...classified, message: '' };
}
