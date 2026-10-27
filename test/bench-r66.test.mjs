/**
 * Круг 66 (SPEC §18.4): замер раскладки на вложенном макете (`--shape nested`) идёт и сверяет каждую
 * правку, отмену и догон с полной раскладкой (расхождение — падение замера).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('../tools/bench-layout.mjs', import.meta.url));

test('круг66: замер вложенного макета — сверка с полной раскладкой проходит', () => {
  for (const shape of ['nested', 'flat']) {
    const out = execFileSync(process.execPath, [tool, '--nodes', '300', '--runs', '3', '--shape', shape, '--json'], { encoding: 'utf8' });
    const [row] = JSON.parse(out);
    assert.equal(row.shape, shape);
    assert.ok(row.nodes >= 290 && row.nodes <= 310, `слоёв ${row.nodes}`);
    for (const k of ['fullMs', 'incrementalMs', 'undoMs', 'catchupMs']) assert.ok(row[k] >= 0, k);
  }
});
