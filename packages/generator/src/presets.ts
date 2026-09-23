/** Пресеты документов (SPEC §5): приёмочный 50×500 и вспомогательные. */
import type { GenParams } from './generate.js';

export type PresetName =
  | 'acceptance'
  | 'cmd-50x500'
  | 'small-5x100'
  | 'small-10x200'
  | 'large-100x500'
  | 'dense-50x1000'
  | 'frac-25x500'
  | 'frac-100x500'
  | 'bob-5x50';

export const PRESETS: Record<PresetName, GenParams> = {
  acceptance: {
    pages: 50, shapesPerPage: 500, sources: 20, instancesPerSource: 25, overrideShare: 0.2,
    seed: 50500, owner: 'u-alice', name: 'acceptance', id: 'doc-acc-50x500', s1Instances: 100, s1Pages: 10,
  },
  // Документ серии `command-shape`: те же 50×500 = 25 000 фигур, тот же seed и тот же S1
  // (100 экземпляров на 10 страницах), плюс ТРИ источника с заданным размещением экземпляров —
  // ими варьируются доля изменённых объектов и их размещение при неизменном размере документа
  // (введение: «одна команда может затронуть множество фигур на одной странице либо по одной
  // фигуре на многих страницах»). Предсказуемые результаты `setSourceFill`:
  //   src-1  (baseline)     100 экз. / 10 страниц → 81 фигура, 10 страниц (как во всех прежних сериях)
  //   src-21 (concentrated) 100 экз. на странице 2 → 81 фигура, 2 страницы (страница 2 + library)
  //   src-22 (spread)       по 1 экз. на каждой из 50 страниц → 51 фигура, 50 страниц
  //   src-23 (large-share)  по 50 экз. на каждой из 50 страниц → 2 001 фигура, 50 страниц
  'cmd-50x500': {
    pages: 50, shapesPerPage: 500, sources: 20, instancesPerSource: 25, overrideShare: 0.2,
    seed: 50500, owner: 'u-alice', name: 'cmd-50x500', id: 'doc-cmd-50x500', s1Instances: 100, s1Pages: 10,
    shapedSources: [
      { name: 'concentrated', pages: [2], perPage: 100 },
      { name: 'spread', pages: 'all', perPage: 1 },
      { name: 'large-share', pages: 'all', perPage: 50 },
    ],
  },
  'small-5x100': {
    pages: 5, shapesPerPage: 100, sources: 5, instancesPerSource: 8, overrideShare: 0.2,
    seed: 5100, owner: 'u-alice', name: 'small-5x100', id: 'doc-small-5x100', s1Instances: 100, s1Pages: 10,
  },
  'small-10x200': {
    pages: 10, shapesPerPage: 200, sources: 10, instancesPerSource: 10, overrideShare: 0.2,
    seed: 10200, owner: 'u-alice', name: 'small-10x200', id: 'doc-small-10x200', s1Instances: 100, s1Pages: 10,
  },
  'large-100x500': {
    pages: 100, shapesPerPage: 500, sources: 30, instancesPerSource: 30, overrideShare: 0.2,
    seed: 100500, owner: 'u-alice', name: 'large-100x500', id: 'doc-large-100x500', s1Instances: 100, s1Pages: 10,
  },
  'dense-50x1000': {
    pages: 50, shapesPerPage: 1000, sources: 40, instancesPerSource: 40, overrideShare: 0.2,
    seed: 501000, owner: 'u-alice', name: 'dense-50x1000', id: 'doc-dense-50x1000', s1Instances: 100, s1Pages: 10,
  },
  // ---- ось «размер документа при ПОСТОЯННОЙ доле посещённого» (серия size-fraction) ----------
  // Дефект «размер и доля меняются вместе»: на прежней оси размера маршрут подстраивался под
  // документ, и доля посещённых страниц шла 100 / 70 / 14 / 7 / 14 %, поэтому отношение обмена
  // оказывалось функцией ДОЛИ, а не размера. Здесь доля закреплена: 12 % страниц документа
  // (3 из 25, 6 из 50, 12 из 100), страница фиксирована на 500 фигурах, меняется ЧИСЛО СТРАНИЦ,
  // то есть размер документа: 12 500 → 25 000 → 50 000 фигур.
  //
  // Структура источников СОВПАДАЕТ с приёмочным документом (20 источников × 25 экземпляров,
  // overrideShare 0.2, S1 = 100 экземпляров на 10 страницах → команда меняет ровно 81 фигуру на
  // 10 страницах при любом размере), поэтому вдоль оси меняется только число страниц.
  // Средний размер оси — приёмочный документ 50×500 (doc-acc-50x500), он уже сгенерирован.
  'frac-25x500': {
    pages: 25, shapesPerPage: 500, sources: 20, instancesPerSource: 25, overrideShare: 0.2,
    seed: 25500, owner: 'u-alice', name: 'frac-25x500', id: 'doc-frac-25x500', s1Instances: 100, s1Pages: 10,
  },
  'frac-100x500': {
    pages: 100, shapesPerPage: 500, sources: 20, instancesPerSource: 25, overrideShare: 0.2,
    seed: 1000500, owner: 'u-alice', name: 'frac-100x500', id: 'doc-frac-100x500', s1Instances: 100, s1Pages: 10,
  },
  // Документ Боба — для проверок безопасности (403 у Алисы).
  'bob-5x50': {
    pages: 5, shapesPerPage: 50, sources: 3, instancesPerSource: 5, overrideShare: 0.2,
    seed: 550, owner: 'u-bob', name: 'bob-5x50', id: 'doc-bob-5x50', s1Instances: 20, s1Pages: 10,
  },
};

export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];
