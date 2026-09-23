/**
 * CLI генератора документов стенда (SPEC §5).
 *
 *   tsx src/cli.ts generate --pages 50 --shapesPerPage 500 --sources 20 --instancesPerSource 25 \
 *                           --overrideShare 0.2 --seed 50500 --owner u-alice --name acceptance --id doc-acc-50x500 [--load]
 *   tsx src/cli.ts preset acceptance [--load]        # генерация пресета (+ загрузка)
 *   tsx src/cli.ts gen-all [--no-load]               # все пресеты
 *   tsx src/cli.ts load data/acceptance.json         # загрузка JSON в PostgreSQL (+ shapes_baseline)
 *   tsx src/cli.ts reset doc-acc-50x500              # сброс заливок/ревизии/операций к снимку
 *   tsx src/cli.ts verify data/acceptance.json       # проверка sha256 и инвариантов
 *   tsx src/cli.ts presets                           # список пресетов
 * Общие опции: --out <dir> (по умолчанию <repo>/data), --db <url> (или STAND_DB_URL).
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { countDocument, createSql, loadDocument, resetDocument } from './db.js';
import { defaultDataDir, exportDocument, readDocumentFile } from './fileio.js';
import { generateDocument, type DocumentFile, type GenParams } from './generate.js';
import { PRESET_NAMES, PRESETS, type PresetName } from './presets.js';
import { checkInvariants } from './verify.js';

const options = {
  pages: { type: 'string' },
  shapesPerPage: { type: 'string' },
  sources: { type: 'string' },
  instancesPerSource: { type: 'string' },
  overrideShare: { type: 'string' },
  seed: { type: 'string' },
  owner: { type: 'string' },
  name: { type: 'string' },
  id: { type: 'string' },
  s1Instances: { type: 'string' },
  s1Pages: { type: 'string' },
  out: { type: 'string' },
  db: { type: 'string' },
  load: { type: 'boolean', default: false },
  'no-load': { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

function usage(): never {
  console.log(
    [
      'stand-gen <command> [options]',
      '  generate  --name <name> [--pages N --shapesPerPage M --sources K --instancesPerSource I --overrideShare S',
      '            --seed X --owner u-alice --id doc-...] [--s1Instances 100 --s1Pages 10] [--out dir] [--load]',
      '  preset    <name> [--load]      генерация пресета; имена: ' + PRESET_NAMES.join(', '),
      '  gen-all   [--no-load]          все пресеты',
      '  load      <file.json> [--force] загрузка в PostgreSQL (проверяет sha256)',
      '  reset     <docId>              сброс к снимку генератора',
      '  verify    <file.json>          проверка sha256 и инвариантов',
      '  presets                        список пресетов',
      'Опции: --out <dir> (по умолчанию <repo>/data), --db <url> (или STAND_DB_URL)',
    ].join('\n'),
  );
  process.exit(2);
}

function num(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${v}"`);
  return n;
}

function summarize(doc: DocumentFile): string {
  const m = doc.meta;
  return (
    `${doc.document.id} (${m.params.name}, owner ${doc.document.ownerId}): ${m.pageCount} pages × ${m.params.shapesPerPage} = ${m.shapeCount} shapes; ` +
    `${m.sourceCount} sources on ${m.libraryPageId}; ${m.instanceCount} instances; ` +
    `S1=${m.s1.id}: ${m.s1.instances} instances (${m.s1.overridden} overridden) on pages [${m.s1.pageIndexes.join(',')}]` +
    (m.shaped?.length
      ? '\n' +
        m.shaped
          .map(
            (s) =>
              `           shaped "${s.name}" ${s.id}: ${s.instances} instances (${s.overridden} overridden) ` +
              `= ${s.perPage}/page × ${s.pageIndexes.length} pages → setSourceFill changes ${s.affectedShapes} shapes on ${s.affectedPages} pages`,
          )
          .join('\n')
      : '')
  );
}

async function doLoad(doc: DocumentFile, dbUrl: string | undefined): Promise<void> {
  const sql = createSql(dbUrl);
  try {
    const r = await loadDocument(sql, doc);
    const c = await countDocument(sql, doc.document.id);
    console.log(`[load] ${r.documentId}: ${r.pages} pages, ${r.shapes} shapes in ${r.ms} ms; db counts:`, c);
  } finally {
    await sql.end();
  }
}

async function generateAndExport(params: Partial<GenParams> & { name: string }, outDir: string): Promise<DocumentFile> {
  const t0 = performance.now();
  const doc = generateDocument(params);
  const inv = checkInvariants(doc);
  if (!inv.ok) throw new Error(`invariants violated:\n  ${inv.errors.join('\n  ')}`);
  const exp = await exportDocument(doc, outDir);
  console.log(`[generate] ${summarize(doc)}`);
  console.log(`[export] ${exp.jsonPath} (${(exp.bytes / 1024 / 1024).toFixed(2)} MiB) sha256=${exp.sha256} in ${Math.round(performance.now() - t0)} ms`);
  return doc;
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true });
  const command = positionals[0];
  if (values.help || !command) usage();
  const outDir = values.out ? path.resolve(values.out) : defaultDataDir();
  const dbUrl = values.db;

  switch (command) {
    case 'presets': {
      for (const n of PRESET_NAMES) {
        const p = PRESETS[n];
        console.log(`${n.padEnd(14)} id=${p.id.padEnd(20)} owner=${p.owner.padEnd(8)} ${p.pages}×${p.shapesPerPage} sources=${p.sources} ips=${p.instancesPerSource} seed=${p.seed}`);
      }
      return;
    }
    case 'generate': {
      if (!values.name) throw new Error('--name is required');
      const params: Partial<GenParams> & { name: string } = {
        name: values.name,
        pages: num(values.pages, 'pages'),
        shapesPerPage: num(values.shapesPerPage, 'shapesPerPage'),
        sources: num(values.sources, 'sources'),
        instancesPerSource: num(values.instancesPerSource, 'instancesPerSource'),
        overrideShare: num(values.overrideShare, 'overrideShare'),
        seed: num(values.seed, 'seed'),
        s1Instances: num(values.s1Instances, 's1Instances'),
        s1Pages: num(values.s1Pages, 's1Pages'),
        owner: values.owner,
        id: values.id,
      };
      for (const k of Object.keys(params) as (keyof typeof params)[]) if (params[k] === undefined) delete params[k];
      const doc = await generateAndExport(params, outDir);
      if (values.load) await doLoad(doc, dbUrl);
      return;
    }
    case 'preset': {
      const name = positionals[1] as PresetName | undefined;
      if (!name || !(name in PRESETS)) throw new Error(`unknown preset "${name}"; known: ${PRESET_NAMES.join(', ')}`);
      const doc = await generateAndExport(PRESETS[name], outDir);
      if (values.load) await doLoad(doc, dbUrl);
      return;
    }
    case 'gen-all': {
      for (const name of PRESET_NAMES) {
        const doc = await generateAndExport(PRESETS[name], outDir);
        if (!values['no-load']) await doLoad(doc, dbUrl);
      }
      return;
    }
    case 'load': {
      const file = positionals[1];
      if (!file) throw new Error('load: file path is required');
      const { doc, checksumOk, sha256 } = await readDocumentFile(path.resolve(file));
      if (checksumOk === false && !values.force) throw new Error(`${file}: sha256 mismatch (${sha256}); use --force to load anyway`);
      if (checksumOk === null) console.warn(`[load] warning: no .sha256 file next to ${file}`);
      await doLoad(doc, dbUrl);
      return;
    }
    case 'reset': {
      const docId = positionals[1];
      if (!docId) throw new Error('reset: docId is required');
      const sql = createSql(dbUrl);
      try {
        const r = await resetDocument(sql, docId);
        if (!r) throw new Error(`document "${docId}" not found`);
        console.log('[reset]', r);
      } finally {
        await sql.end();
      }
      return;
    }
    case 'verify': {
      const file = positionals[1];
      if (!file) throw new Error('verify: file path is required');
      const { doc, checksumOk, sha256 } = await readDocumentFile(path.resolve(file));
      const inv = checkInvariants(doc);
      console.log(`[verify] ${summarize(doc)}`);
      console.log(`[verify] sha256=${sha256} checksum=${checksumOk === null ? 'no .sha256 file' : checksumOk ? 'OK' : 'MISMATCH'}`);
      console.log(`[verify] invariants: ${inv.ok ? 'OK' : 'FAILED'}`);
      for (const e of inv.errors) console.log(`  - ${e}`);
      if (!inv.ok || checksumOk === false) process.exit(1);
      return;
    }
    default:
      usage();
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error('[stand-gen] error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
