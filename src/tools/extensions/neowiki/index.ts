import type { ExtensionPack } from '../types.ts';
import { neowikiListSchemas } from './neowiki-list-schemas.ts';
import { neowikiGetSchema } from './neowiki-get-schema.ts';
import { neowikiCypherQuery } from './neowiki-cypher-query.ts';
import { neowikiSearchSubjects } from './neowiki-search-subjects.ts';
import { neowikiGetSubject } from './neowiki-get-subject.ts';
import { neowikiGetPageSubjects } from './neowiki-get-page-subjects.ts';
import { neowikiCreateSubject } from './neowiki-create-subject.ts';
import { neowikiUpdateSubject } from './neowiki-update-subject.ts';
import { neowikiDeleteSubject } from './neowiki-delete-subject.ts';
import { neowikiSetMainSubject } from './neowiki-set-main-subject.ts';
import { neowikiValidateSubject } from './neowiki-validate-subject.ts';

export const neowikiPack: ExtensionPack = {
	id: 'neowiki',
	extensionNames: ['NeoWiki'],
	tools: [
		neowikiListSchemas,
		neowikiGetSchema,
		neowikiCypherQuery,
		neowikiSearchSubjects,
		neowikiGetSubject,
		neowikiGetPageSubjects,
		neowikiCreateSubject,
		neowikiUpdateSubject,
		neowikiDeleteSubject,
		neowikiSetMainSubject,
		neowikiValidateSubject,
	],
};
