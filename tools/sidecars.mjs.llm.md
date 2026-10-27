# `tools/sidecars.mjs` — заметка для LLM

> Сайдкар: карта файла для отладки. Источник истины — код и SPEC.md. Меняешь файл — обнови заметку в том же коммите (конституция, принцип VII; проверка — `node tools/sidecars.mjs`).

## Назначение
Проверка правила сайдкаров (конституция, принцип VII): у каждого файла кода (`*.js`, `*.mjs`, `*.html`, `*.css`) есть заметка `<файл>.llm.md` — или `README.llm.md` его каталога, — и нет заметок без файла. С `--changed <база>` — ещё и «файл менялся с базы, а заметка нет».

## Главное
- `scan(root)` → `{code, notes, covered}`; обход пропускает `node_modules, dist, .git, .specify, .claude, specs, test` и порождённый `dev.html`.
- `noteOf(file, covered)` — какая заметка отвечает за файл.
- `check(root)` → `{missing, orphans, code, notes}` — её зовёт `test/sidecars.test.mjs` (часть `npm test`).
- `stale(base, root)` — по `git diff --name-only base...HEAD`.
- CLI: `node tools/sidecars.mjs [--changed <база>] [--json]`, выход 1 при нарушениях.

## Инварианты
Тесты (`test/`) не требуют заметки на файл: каталог описан `test/README.llm.md`. Изменение набора расширений или пропусков — правка конституции (принцип VII) и этой заметки.

## Отладка
`node tools/sidecars.mjs`; перед PR — `node tools/sidecars.mjs --changed origin/<база PR>`.

## Ссылки
- `.specify/memory/constitution.md` (принцип VII), `.specify/templates/sidecar-template.md`, `CLAUDE.md`
- Тесты: `test/sidecars.test.mjs`
