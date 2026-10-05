# EmbeddableContent field contract (pinned)

`field-contract.json` is emitted by the **ronzz-wikibase** repo — the
EmbeddableContent extension's `maintenance/emitFieldContract.php`, a pure
projection of `Flow/SpecialContentFieldMap`, `Flow/SourceFieldMap` and
`Flow/SemanticEntityFieldMap` (the single authoring source for the entity-mode
Add\* flows).

It is vendored here **verbatim** (byte-identical, and excluded from oxfmt in
`.prettierignore`) so the build is hermetic: the generator never reaches the
network or another repo.

## Refresh

```sh
cp <ronzz-wikibase>/extensions/EmbeddableContent/contract/field-contract.json \
   src/tools/extensions/embeddable-content/contract/field-contract.json
npm run gen:field-contract
```

## How the drift guard works

- `scripts/gen-embeddable-contract.cjs` projects the contract to
  `generated/fieldContract.ts` — the field tables each add tool exposes. Its
  `EXCLUDED` map documents any contract field the tools deliberately do not
  expose (a field named there that is not in the contract is an error).
- Each add tool declares its validators as
  `FIELD_VALIDATORS satisfies Record<FieldName, z.ZodTypeAny>`, so adding,
  renaming or removing a contract field fails **compilation** until the tool is
  brought in step.
- CI runs `npm run gen:field-contract` (inside `preflight`) and then
  `git diff --exit-code`: a hand-edited generated file, or a contract edit
  without regeneration, fails the build.
- `tests/tools/extensions/embeddable-content/field-contract.test.ts` enforces
  the same at test time, so a stale generated file is caught without a full CI
  run.
