import type { ExtensionPack } from '../types.ts';
import { neowikiListSchemas } from './neowiki-list-schemas.ts';
import { neowikiGetSchema } from './neowiki-get-schema.ts';
import { neowikiCreateSchema } from './neowiki-create-schema.ts';
import { neowikiUpdateSchema } from './neowiki-update-schema.ts';
import { neowikiDeleteSchema } from './neowiki-delete-schema.ts';
import { neowikiCypherQuery } from './neowiki-cypher-query.ts';
import { neowikiSparqlQuery } from './neowiki-sparql-query.ts';
import { neowikiSearchSubjects } from './neowiki-search-subjects.ts';
import { neowikiListSubjects } from './neowiki-list-subjects.ts';
import { neowikiGetSubject } from './neowiki-get-subject.ts';
import { neowikiGetReferencingSubjects } from './neowiki-get-referencing-subjects.ts';
import { neowikiGetPageSubjects } from './neowiki-get-page-subjects.ts';
import { neowikiCreateSubject } from './neowiki-create-subject.ts';
import { neowikiUpdateSubject } from './neowiki-update-subject.ts';
import { neowikiSetStatement } from './neowiki-set-statement.ts';
import { neowikiRemoveStatement } from './neowiki-remove-statement.ts';
import { neowikiDeleteSubject } from './neowiki-delete-subject.ts';
import { neowikiSetMainSubject } from './neowiki-set-main-subject.ts';
import { neowikiMoveSubject } from './neowiki-move-subject.ts';
import { neowikiValidateSubject } from './neowiki-validate-subject.ts';
import { neowikiMintSubjectIds } from './neowiki-mint-subject-ids.ts';

export const neowikiPack: ExtensionPack = {
	id: 'neowiki',
	extensionNames: ['NeoWiki'],
	tools: [
		neowikiListSchemas,
		neowikiGetSchema,
		neowikiCreateSchema,
		neowikiUpdateSchema,
		neowikiDeleteSchema,
		neowikiCypherQuery,
		neowikiSparqlQuery,
		neowikiSearchSubjects,
		neowikiListSubjects,
		neowikiGetSubject,
		neowikiGetReferencingSubjects,
		neowikiGetPageSubjects,
		neowikiCreateSubject,
		neowikiUpdateSubject,
		neowikiSetStatement,
		neowikiRemoveStatement,
		neowikiDeleteSubject,
		neowikiSetMainSubject,
		neowikiMoveSubject,
		neowikiValidateSubject,
		neowikiMintSubjectIds,
	],
};
