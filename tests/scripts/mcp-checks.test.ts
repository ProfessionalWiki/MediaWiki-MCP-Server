import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

type ConformanceCheck = {
	id: string;
	status: string;
	skipReason?: string;
	error?: { message: string };
};

type ConformanceReport = {
	passed?: boolean;
	outcome?: string;
	checks?: unknown;
};

const { judgeConformanceReport } = createRequire(import.meta.url)(
	'../../scripts/mcp-checks.cjs',
) as {
	judgeConformanceReport: (report: unknown) => string[];
};

function passingChecks(count: number): ConformanceCheck[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `check-${index}`,
		status: 'passed',
	}));
}

function unrunCheck(id: string): ConformanceCheck {
	return {
		id,
		status: 'skipped',
		skipReason: 'could-not-run',
		error: { message: 'No inputRequiredProbe configured' },
	};
}

// The shape a 2026-era SDK reports: a verdict plus a reason per skip.
function modernReport(overrides: Partial<ConformanceReport> = {}): ConformanceReport {
	return {
		passed: true,
		outcome: 'passed',
		checks: passingChecks(36),
		...overrides,
	};
}

// The shape the currently pinned SDK reports: a bare boolean, no outcome
// and no skip reasons.
function legacyReport(overrides: Partial<ConformanceReport> = {}): ConformanceReport {
	return {
		passed: true,
		checks: passingChecks(31),
		...overrides,
	};
}

describe('judgeConformanceReport', () => {
	it('accepts a run that passed every check', () => {
		expect(judgeConformanceReport(modernReport())).toEqual([]);
	});

	it('accepts an incomplete run whose unrunnable checks are all tolerated', () => {
		const report = modernReport({
			passed: false,
			outcome: 'incomplete',
			checks: [
				...passingChecks(34),
				unrunCheck('modern-undeclared-capability-error'),
				unrunCheck('modern-subscription-graceful-close'),
			],
		});

		expect(judgeConformanceReport(report)).toEqual([]);
	});

	it('rejects an unrunnable check that is not tolerated', () => {
		const report = modernReport({
			passed: false,
			outcome: 'incomplete',
			checks: [
				...passingChecks(34),
				unrunCheck('modern-undeclared-capability-error'),
				unrunCheck('modern-some-future-obligation'),
			],
		});

		expect(judgeConformanceReport(report)).toEqual([
			expect.stringContaining('modern-some-future-obligation'),
		]);
	});

	it('rejects a check that failed', () => {
		const report = modernReport({
			passed: false,
			outcome: 'failed',
			checks: [
				...passingChecks(35),
				{
					id: 'post-response-content-type',
					status: 'failed',
					error: { message: 'unexpected content type text/plain' },
				},
			],
		});

		expect(judgeConformanceReport(report)).toContainEqual(
			expect.stringContaining('post-response-content-type'),
		);
	});

	it('rejects a run whose outcome is neither passed nor incomplete', () => {
		expect(judgeConformanceReport(modernReport({ passed: false, outcome: 'failed' }))).toEqual([
			expect.stringContaining('failed'),
		]);
	});

	it('rejects a run that selected almost no checks', () => {
		expect(judgeConformanceReport(modernReport({ checks: [] }))).toEqual([
			expect.stringContaining('0 of the'),
		]);
	});

	it('rejects a report carrying no checks at all', () => {
		expect(judgeConformanceReport({ passed: true })).not.toEqual([]);
	});

	it('accepts a legacy report that reports itself as passed', () => {
		expect(judgeConformanceReport(legacyReport())).toEqual([]);
	});

	it('rejects a legacy report that reports itself as not passed', () => {
		expect(judgeConformanceReport(legacyReport({ passed: false }))).not.toEqual([]);
	});
});
