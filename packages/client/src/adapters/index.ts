import type { AdapterKind, LoadMode } from '@stand/shared';
import type { DataAdapter } from './types';

export type { DataAdapter } from './types';
export { ADAPTER_SETTINGS } from './types';

/**
 * Модули адаптеров загружаются динамическим import'ом — Vite выносит каждый в отдельный chunk,
 * поэтому H/Q не платят за клиент Zero (≈300 КБ), а Z — за TanStack Query. Общие модули адаптеров
 * (doc-state, limiter, read-page, commands) bundler кладёт в небольшие общие chunk'и, которые
 * Vite подгружает параллельно с chunk'ом адаптера (modulepreload) — один RTT на всё.
 */
type AdapterModule = { create(mode: LoadMode, cacheWindow: number): DataAdapter };

const loaders: Record<AdapterKind, () => Promise<AdapterModule>> = {
  H: async () => {
    const m = await import('./h');
    return { create: (mode, cache) => new m.HAdapter(mode, cache) };
  },
  Q: async () => {
    const m = await import('./q');
    return { create: (mode, cache) => new m.QAdapter(mode, cache) };
  },
  Z: async () => {
    const m = await import('./z');
    return { create: (mode, cache) => new m.ZAdapter(mode, cache) };
  },
};

const loaded = new Map<AdapterKind, Promise<AdapterModule>>();

/** Начать загрузку chunk'а адаптера заранее (параллельно с login), чтобы не добавлять запрос в измеряемый путь открытия. */
export function preloadAdapter(kind: AdapterKind): Promise<AdapterModule> {
  let p = loaded.get(kind);
  if (!p) {
    p = loaders[kind]();
    loaded.set(kind, p);
    p.catch(() => loaded.delete(kind));
  }
  return p;
}

export async function createAdapter(kind: AdapterKind, mode: LoadMode, cacheWindow: number): Promise<DataAdapter> {
  const m = await preloadAdapter(kind);
  return m.create(mode, cacheWindow);
}
