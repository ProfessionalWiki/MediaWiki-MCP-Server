/**
 * The reason Cargo gave for refusing a query or table, or undefined for any
 * other database error. Cargo's API answers both with code `db_error`, but only
 * its own refusals carry an "Error: …" message.
 */
export function cargoRefusal(message: string): string | undefined {
	return message.match(/^db_error: ⧼?Error: ([^⧽]+)/)?.[1]?.trim();
}
