import { z } from 'zod';
import { readFile, access } from 'fs/promises';
import { basename } from 'path';
import { constants } from 'fs';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getLegacyCsrfToken } from '../common/legacy-api.js';
import { scriptPath, wikiServer, oauthToken, wikiLanguage } from '../common/config.js';
import { USER_AGENT } from '../server.js';
import fetch, { FormData, Blob } from 'node-fetch';

export function uploadFileTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'upload-file',
		'Uploads a file from the local filesystem to MediaWiki. 🔐 Requires authentication.',
		{
			localFilePath: z.string().describe( 'The absolute path to the file on the local filesystem' ),
			wikiFilename: z.string().describe( 'The desired filename for the file on MediaWiki (e.g., "MyImage.png" or "File:MyImage.png")' ),
			comment: z.string().describe( 'A summary for the upload log entry on MediaWiki' ).optional(),
			ignoreWarnings: z.boolean().describe( 'Whether to ignore warnings (e.g., overwrite existing file)' ).optional()
		},
		{
			title: 'Upload file',
			readOnlyHint: false,
			destructiveHint: true
		} as ToolAnnotations,
		async (
			{ localFilePath, wikiFilename, comment, ignoreWarnings }
		) => handleUploadFileTool( localFilePath, wikiFilename, comment, ignoreWarnings )
	);
}

async function handleUploadFileTool(
	localFilePath: string,
	wikiFilename: string,
	comment?: string,
	ignoreWarnings?: boolean
): Promise<CallToolResult> {
	try {
		// Check if OAuth token is available
		const token = oauthToken();
		if ( !token ) {
			return {
				content: [
					{ type: 'text', text: 'Authentication required: No OAuth token available for file upload. Please configure OAuth credentials in your wiki configuration.' } as TextContent
				],
				isError: true
			};
		}

		// Validate local file exists and is readable
		try {
			await access( localFilePath, constants.R_OK );
		} catch ( fileError ) {
			return {
				content: [
					{ type: 'text', text: `File not found or not readable: ${ localFilePath }. Error: ${ ( fileError as Error ).message }` } as TextContent
				],
				isError: true
			};
		}

		// Normalize filename - remove "File:" prefix if present since API expects just the filename
		let filename = wikiFilename;
		if ( filename.startsWith( 'File:' ) ) {
			filename = filename.slice( 5 );
		}

		// Read the file from local filesystem
		let fileBuffer: Buffer;
		try {
			fileBuffer = await readFile( localFilePath );
		} catch ( fileError ) {
			return {
				content: [
					{ type: 'text', text: `Failed to read local file: ${ ( fileError as Error ).message }` } as TextContent
				],
				isError: true
			};
		}

		// Get CSRF token using legacy API (works reliably with OAuth 2.0)
		const csrfToken = await getLegacyCsrfToken();
		if ( !csrfToken ) {
			return {
				content: [
					{ type: 'text', text: 'Failed to obtain CSRF token for file upload' } as TextContent
				],
				isError: true
			};
		}

		// Prepare the upload using legacy Action API
		const result = await uploadFileToMediaWiki(
			fileBuffer,
			filename,
			localFilePath,
			comment || 'Uploaded via MediaWiki MCP Server',
			ignoreWarnings || false,
			csrfToken,
			token
		);

		if ( result.success ) {
			return {
				content: [
					{
						type: 'text',
						text: `File uploaded successfully: File:${ result.filename }`
					},
					{
						type: 'text',
						text: [
							'Upload details:',
							`Filename: ${ result.filename }`,
							`File size: ${ result.size ? `${ result.size } bytes` : 'Unknown' }`,
							`Upload comment: ${ comment || 'Uploaded via MediaWiki MCP Server' }`,
							result.url ? `File page URL: ${ result.url }` : ''
						].filter( Boolean ).join( '\n' )
					}
				]
			};
		} else {
			return {
				content: [
					{ type: 'text', text: `Failed to upload file: ${ result.error }` } as TextContent
				],
				isError: true
			};
		}
	} catch ( error ) {
		return {
			content: [
				{ type: 'text', text: `File upload failed: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}
}

async function uploadFileToMediaWiki(
	fileBuffer: Buffer,
	filename: string,
	originalPath: string,
	comment: string,
	ignoreWarnings: boolean,
	csrfToken: string,
	oAuthToken: string
): Promise<{
		success: boolean;
		filename?: string;
		size?: number;
		url?: string;
		error?: string;
	}> {
	try {
		const baseUrl = `${ wikiServer() }${ scriptPath() }/api.php`;

		// Create FormData for multipart upload
		const formData = new FormData();

		// Add the file as a Blob
		const fileBlob = new Blob( [ fileBuffer ], {
			type: 'application/octet-stream'
		} );
		formData.append( 'file', fileBlob, basename( originalPath ) );

		// Add other parameters
		formData.append( 'action', 'upload' );
		formData.append( 'filename', filename );
		formData.append( 'comment', comment );
		formData.append( 'token', csrfToken );
		formData.append( 'format', 'json' );
		formData.append( 'uselang', wikiLanguage() );

		if ( ignoreWarnings ) {
			formData.append( 'ignorewarnings', '1' );
		}

		// Prepare headers
		const headers: Record<string, string> = {
			'User-Agent': USER_AGENT,
			'Accept-Language': wikiLanguage(),
			Authorization: `Bearer ${ oAuthToken }`
		};

		// Make the upload request
		const response = await fetch( baseUrl, {
			method: 'POST',
			headers,
			body: formData
		} );

		if ( !response.ok ) {
			const errorBody = await response.text().catch( () => 'Could not read error response body' );
			throw new Error( `HTTP ${ response.status }: ${ errorBody }` );
		}

		const responseData = await response.json() as {
			upload?: {
				result?: string;
				filename?: string;
				size?: number;
				warnings?: Record<string, unknown>;
			};
			error?: {
				code?: string;
				info?: string;
			};
		};

		// Check for successful upload
		if ( responseData.upload?.result === 'Success' ) {
			const uploadedFilename = responseData.upload.filename || filename;
			return {
				success: true,
				filename: uploadedFilename,
				size: responseData.upload.size,
				url: `${ wikiServer() }/wiki/File:${ encodeURIComponent( uploadedFilename ) }`
			};
		}

		// Check for warnings (if ignoreWarnings is false)
		if ( responseData.upload?.warnings && !ignoreWarnings ) {
			const warnings = Object.keys( responseData.upload.warnings ).join( ', ' );
			return {
				success: false,
				error: `Upload warnings: ${ warnings }. Use ignoreWarnings=true to override.`
			};
		}

		// Check for API errors
		if ( responseData.error ) {
			return {
				success: false,
				error: `${ responseData.error.code }: ${ responseData.error.info }`
			};
		}

		// Unknown response format
		return {
			success: false,
			error: `Unexpected API response: ${ JSON.stringify( responseData ) }`
		};

	} catch ( error ) {
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Unknown upload error'
		};
	}
}
