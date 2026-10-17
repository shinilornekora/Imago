/**
 * Круг 30 — ядро: Stage._onResize не переписывает viewBox, когда масштаб прежний.
 *
 * Появление колонки инспектора сужает сцену. При `preserveAspectRatio="xMinYMin slice"`
 * масштаб картинки — max(ширина / ширина viewBox, высота / высота viewBox): сцена уже при
 * той же высоте — та же картинка, справа просто меньше видно. Переписанный viewBox стоил
 * второй полной раскладки SVG (на 10 000 узлах 200–350 мс к первому выделению).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stage } from '../src/core.js';

function fakeStage(w, h) {
  const st = Object.create(Stage.prototype);
  const writes = [];
  st.el = { clientWidth: w, clientHeight: h };
  st.svg = { setAttribute(k, v) { if (k === 'viewBox') writes.push(v); } };
  st.view = { zoom: 0.5, pan: { x: 40, y: 20 } };
  st.doc = { nodes: {} };
  st._vp = null;
  st._viewBox = null;
  st._vbBase = null;
  st._gridGroup = null;
  st._labels = [];
  st._dead = false;
  let painted = 0;
  st._paintUI = () => { painted++; };
  return { st, writes, painted: () => painted };
}

test('круг30: сцена сузилась по одной оси при том же виде — viewBox не переписывается, накладка перерисовывается', () => {
  const { st, writes, painted } = fakeStage(1200, 800);
  st._applyView();
  assert.equal(writes.length, 1, 'первая запись');
  const first = writes[0];

  // инспектор появился: уже на 280 px, высота та же
  st.el.clientWidth = 920;
  st._resized();
  assert.equal(writes.length, 0 + 1, 'viewBox прежний');
  assert.equal(painted(), 1, 'накладка (бейджи у края) — по новому размеру');
  assert.equal(st.vw, 920, 'размер вьюпорта — новый');
  // тот же размер ещё раз (ResizeObserver после observe) — ничего
  st._resized();
  assert.equal(painted(), 1);
  // рендер после правки зовёт _applyView — и он тоже не роняет раскладку SVG
  st._applyView();
  assert.equal(writes.length, 1, 'рендер после сужения viewBox не трогает');

  // инспектор скрыт: ширина вернулась к той, под которую записан viewBox, — та же картинка
  st.el.clientWidth = 1200;
  st._resized();
  assert.equal(writes.length, 1, 'вернулась к записанной — viewBox прежний');
  assert.equal(painted(), 2);

  // шире записанной — масштаб slice вырос бы: viewBox обязан смениться
  st.el.clientWidth = 1400;
  st._resized();
  assert.equal(writes.length, 2, 'шире — новый viewBox');
  assert.notEqual(writes[1], first);
  assert.equal(writes[1].split(' ')[2], String(1400 / 0.5));

  // уже по обеим осям — масштаб упал бы: новый viewBox
  st.el.clientWidth = 1000;
  st.el.clientHeight = 700;
  st._resized();
  assert.equal(writes.length, 3, 'уже по обеим осям — новый viewBox');

  // сузилась, потом сдвиг вида — запись по нынешнему размеру
  st.el.clientWidth = 800;
  st._resized();
  assert.equal(writes.length, 3);
  st.view.pan.x += 10;
  st._applyView();
  assert.equal(writes.length, 4, 'вид сменился — viewBox новый');
  assert.equal(writes[3].split(' ')[2], String(800 / 0.5), 'и по нынешнему размеру');
  // зум — тоже
  st.view.zoom = 1;
  st._applyView();
  assert.equal(writes.length, 5);
});
