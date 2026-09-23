import type { AdapterKind, LoadMode, StandConfig } from '@stand/shared';

/** Конфигурация клиента из query‑параметров (SPEC §4). */
export interface ClientConfig extends StandConfig {
  /** логин тестовой учётной записи для автоматического входа (укорачивает измеряемый путь) */
  autologin: string | null;
  /** пароль для `?autologin` из query‑параметра `pass` (см. `passwordFor`) */
  autologinPassword: string | null;
}

const ADAPTERS: ReadonlySet<string> = new Set(['H', 'Q', 'Z']);
const MODES: ReadonlySet<string> = new Set(['F', 'P']);

/**
 * Пароли тестовых учёток (§1.6). В production‑сборку они попадать НЕ должны.
 *
 * `import.meta.env.DEV` компилируется в `false` при `vite build`, поэтому этот объект
 * сворачивается в `{}` и строки паролей в бандл не попадают
 * (проверка: `grep -r "alice-pass" packages/client/dist` → 0 вхождений). В dev‑сервере
 * (`vite`, не участвует в измерениях) короткая форма `?autologin=alice` продолжает работать.
 */
const DEV_PASSWORDS: Readonly<Record<string, string>> = import.meta.env.DEV ? { alice: 'alice-pass', bob: 'bob-pass' } : {};

/**
 * Пароль автологина, переданный оболочкой В КОНТЕКСТ СТРАНИЦЫ (не через URL).
 *
 * Измерительная оболочка ставит `window.__standCredentials = {login, password}` через
 * `addInitScript` ДО загрузки документа, поэтому пароль не попадает ни в строку запроса, ни в
 * журналы доступа, ни в `Referer`, ни в счётчики шейпера, ни в паспорт серии (закрытие N9).
 * Вход при этом выполняет сама страница — тем же `POST /api/auth/login`, что и форма входа,
 * т. е. измеряемый путь не меняется.
 *
 * `?pass=` остаётся как запасной канал для функциональных проверок (они не измеряют время и
 * запускаются мимо шейпера); измерительная серия им не пользуется.
 */
function passwordFromPageContext(login: string): string | null {
  const c = (window as unknown as { __standCredentials?: { login?: string; password?: string } }).__standCredentials;
  if (c && typeof c.password === 'string' && c.password && (c.login === undefined || c.login === login)) return c.password;
  return null;
}

export function parseConfig(search: string = window.location.search): ClientConfig {
  const q = new URLSearchParams(search);
  const adapterRaw = (q.get('adapter') ?? 'H').toUpperCase();
  const modeRaw = (q.get('mode') ?? 'P').toUpperCase();
  const cacheRaw = Number.parseInt(q.get('cache') ?? '1', 10);
  const adapter: AdapterKind = ADAPTERS.has(adapterRaw) ? (adapterRaw as AdapterKind) : 'H';
  const mode: LoadMode = MODES.has(modeRaw) ? (modeRaw as LoadMode) : 'P';
  const cache = Number.isFinite(cacheRaw) && cacheRaw >= 0 ? cacheRaw : 1;
  const pageRaw = q.get('page');
  const pageNum = pageRaw === null ? NaN : Number.parseInt(pageRaw, 10);
  return {
    adapter,
    mode,
    cache,
    docId: q.get('doc') ?? '',
    // `?page=` — индекс (1‑based) либо pageId; по умолчанию первая страница по индексу
    initialPage: pageRaw === null || pageRaw === '' ? null : Number.isFinite(pageNum) && String(pageNum) === pageRaw.trim() ? pageNum : pageRaw,
    autologin: q.get('autologin'),
    autologinPassword: q.get('pass'),
  };
}

/**
 * Пароль автологина по убыванию приоритета: контекст страницы (`window.__standCredentials`,
 * ставит измерительная оболочка), затем `?pass=` (функциональные проверки), затем — только в
 * dev‑сборке — встроенный пароль тестовой учётки. В production‑сборке без первых двух вернётся
 * `null`, и клиент покажет форму входа, а не войдёт втихую.
 */
export function passwordFor(login: string, fromQuery: string | null = null): string | null {
  const fromPage = passwordFromPageContext(login);
  if (fromPage) return fromPage;
  if (fromQuery) return fromQuery;
  return DEV_PASSWORDS[login] ?? null;
}
