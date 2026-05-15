/**
 * Thrown when a wiki's {exec:…} credential command fails, times out, or
 * produces no output. Surfaces at first use of the wiki, never at startup.
 * The message carries only the command name and truncated stderr — never the
 * command's stdout and never the resolved secret.
 */
export class CredentialResolutionError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'CredentialResolutionError';
	}
}
