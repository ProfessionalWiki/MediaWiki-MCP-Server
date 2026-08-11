import type { ApiDeleteResponse, ApiMoveResponse, ApiUndeleteResponse } from 'mwn';
import type { ApiDeleteParams, ApiMoveParams, ApiUndeleteParams } from 'types-mediawiki-api';

/**
 * mwn's page-write methods, with the reason typed as mwn actually treats it.
 * Each forwards the argument into the action API's `reason` parameter and drops
 * the parameter when the value is `undefined`, which is the only way to send no
 * reason at all; mwn's own documentation marks the argument optional while its
 * type declaration does not. Assign an `Mwn` to this to omit a reason without
 * asserting away the `undefined` that has to survive.
 */
export interface PageWrites {
	delete(
		title: string,
		reason: string | undefined,
		options?: ApiDeleteParams,
	): Promise<ApiDeleteResponse>;
	undelete(
		title: string,
		reason: string | undefined,
		options?: ApiUndeleteParams,
	): Promise<ApiUndeleteResponse>;
	move(
		fromTitle: string,
		toTitle: string,
		reason: string | undefined,
		options?: ApiMoveParams,
	): Promise<ApiMoveResponse>;
}
