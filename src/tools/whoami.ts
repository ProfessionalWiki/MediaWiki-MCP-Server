import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';

const inputSchema = {
	includeRights: z
		.boolean()
		.optional()
		.describe(
			'Also return the full list of user rights granted on this wiki (a long list). Defaults to false.',
		),
} as const;

type WhoamiArgs = z.infer<z.ZodObject<typeof inputSchema>>;

interface RawUserinfo {
	id: number;
	name: string;
	anon?: boolean;
	groups?: string[];
	rights?: string[];
}

interface UserinfoResponse {
	query?: { userinfo?: RawUserinfo };
}

interface WhoamiResult {
	id: number;
	username: string;
	anonymous: boolean;
	groups: string[];
	rights?: string[];
}

export const whoami: Tool<typeof inputSchema> = {
	name: 'whoami',
	description:
		'Returns the identity the current session is authenticated as on the targeted wiki: the username, whether the session is anonymous (no user is logged in), and the user groups it belongs to. Set includeRights to also return the full list of user rights. Use to confirm who edits and uploads will be attributed to before writing — for example, to resolve your own username before building a title under your own user namespace (User:<username>/…). Reports anonymous access rather than failing when the session has no credentials. For which wikis have stored OAuth tokens and their scopes, use oauth-status instead.',
	inputSchema,
	annotations: {
		title: 'Who am I',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'read user identity',

	async handle(args: WhoamiArgs, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const uiprop = args.includeRights === true ? 'groups|rights' : 'groups';

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const response = (await mwn.request({
			action: 'query',
			meta: 'userinfo',
			uiprop,
			formatversion: '2',
		})) as UserinfoResponse;

		const userinfo = response.query?.userinfo;
		if (!userinfo) {
			throw new Error('userinfo response did not include user data');
		}

		const result: WhoamiResult = {
			id: userinfo.id,
			username: userinfo.name,
			anonymous: userinfo.anon === true,
			groups: userinfo.groups ?? [],
		};
		if (args.includeRights === true) {
			result.rights = userinfo.rights ?? [];
		}

		return ctx.format.ok(result);
	},
};
