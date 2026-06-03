import type { ExtensionPack } from '../types.js';
import { neowikiListSchemas } from './neowiki-list-schemas.js';
import { neowikiGetSchema } from './neowiki-get-schema.js';
import { neowikiCypherQuery } from './neowiki-cypher-query.js';
import { neowikiSearchSubjects } from './neowiki-search-subjects.js';
import { neowikiGetSubject } from './neowiki-get-subject.js';
import { neowikiGetPageSubjects } from './neowiki-get-page-subjects.js';
import { neowikiCreateSubject } from './neowiki-create-subject.js';
import { neowikiUpdateSubject } from './neowiki-update-subject.js';
import { neowikiDeleteSubject } from './neowiki-delete-subject.js';
import { neowikiSetMainSubject } from './neowiki-set-main-subject.js';
import { neowikiValidateSubject } from './neowiki-validate-subject.js';

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
