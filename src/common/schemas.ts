import { z } from 'zod';

export const ErrorEnvelopeSchema = z.object( {
	category: z.enum( [
		'not_found', 'permission_denied', 'invalid_input',
		'conflict', 'authentication', 'rate_limited', 'upstream_failure'
	] ),
	message: z.string(),
	code: z.string().optional()
} );
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
