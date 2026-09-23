/**
 * Экспорт/импорт документа: data/<name>.json (одна фигура на строку, детерминированно)
 * и data/<name>.sha256 в формате `sha256sum` (можно проверить `sha256sum -c`).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_FORMAT, type DocumentFile } from './generate.js';

export function defaultDataDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/generator/src → repo root /data
  return path.resolve(here, '..', '..', '..', 'data');
}

export function serializeDocument(doc: DocumentFile): string {
  const head = JSON.stringify({ meta: doc.meta, document: doc.document, pages: doc.pages });
  // Убираем закрывающую скобку, добавляем shapes построчно.
  const lines: string[] = [];
  lines.push(`${head.slice(0, -1)},`);
  lines.push('"shapes":[');
  doc.shapes.forEach((s, i) => {
    lines.push(JSON.stringify(s) + (i < doc.shapes.length - 1 ? ',' : ''));
  });
  lines.push(']}');
  return lines.join('\n') + '\n';
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface ExportResult {
  jsonPath: string;
  shaPath: string;
  sha256: string;
  bytes: number;
}

export async function exportDocument(doc: DocumentFile, dataDir: string = defaultDataDir()): Promise<ExportResult> {
  await mkdir(dataDir, { recursive: true });
  const fileName = `${doc.meta.params.name}.json`;
  const jsonPath = path.join(dataDir, fileName);
  const shaPath = path.join(dataDir, `${doc.meta.params.name}.sha256`);
  const text = serializeDocument(doc);
  const sha = sha256Hex(text);
  await writeFile(jsonPath, text, 'utf8');
  await writeFile(shaPath, `${sha}  ${fileName}\n`, 'utf8');
  return { jsonPath, shaPath, sha256: sha, bytes: Buffer.byteLength(text) };
}

export interface ReadResult {
  doc: DocumentFile;
  sha256: string;
  /** null — файла .sha256 нет; иначе совпала ли сумма. */
  checksumOk: boolean | null;
}

export async function readDocumentFile(jsonPath: string): Promise<ReadResult> {
  const text = await readFile(jsonPath, 'utf8');
  const sha = sha256Hex(text);
  const doc = JSON.parse(text) as DocumentFile;
  if (!doc || doc.meta?.format !== FILE_FORMAT) {
    throw new Error(`${jsonPath}: unexpected format (${String(doc?.meta?.format)}), expected ${FILE_FORMAT}`);
  }
  let checksumOk: boolean | null = null;
  const shaPath = jsonPath.replace(/\.json$/, '.sha256');
  try {
    const expected = (await readFile(shaPath, 'utf8')).trim().split(/\s+/)[0];
    checksumOk = expected === sha;
  } catch {
    checksumOk = null;
  }
  return { doc, sha256: sha, checksumOk };
}
