/**
 * Answers a siteinfo query as MediaWiki does, from `query`, the wiki's full
 * answer in formatversion 2: only the props `siprop` names, and in formatversion
 * 1 unless 2 is asked for, where a namespace flag that is true reads as "".
 */
export function siteinfoAnswer(
	query: Record<string, unknown>,
	params: Readonly<Record<string, unknown>> | undefined,
): { query: Record<string, unknown> } {
	const props = (typeof params?.siprop === 'string' ? params.siprop : 'general').split('|');
	const answered = Object.fromEntries(
		Object.entries(query).filter(([prop]) => props.includes(prop)),
	);
	const formatVersion2 = params?.formatversion === '2' || params?.formatversion === 2;
	if (!formatVersion2 && answered.namespaces !== undefined) {
		answered.namespaces = inFormatVersion1(answered.namespaces as Record<string, object>);
	}
	return { query: answered };
}

function inFormatVersion1(namespaces: Record<string, object>): Record<string, object> {
	return Object.fromEntries(
		Object.entries(namespaces).map(([id, namespace]) => [
			id,
			Object.fromEntries(
				Object.entries(namespace)
					.filter(([, value]) => value !== false)
					.map(([key, value]) => [key, value === true ? '' : value]),
			),
		]),
	);
}
