/**
 * Пределы Orchestrator. Всё, что можно настроить, читается из окружения в index.js;
 * здесь — умолчания и потолки формы запроса.
 */

/** Тело запроса больше — 413 too_large (SPEC §10.2). */
export const MAX_BODY_BYTES = 1024 * 1024;
/**
 * Круг 33: приём запроса (как у Document service, круг 27). Тело не пришло целиком за
 * BODY_TIMEOUT_MS — 408 timeout, соединение закрывается (медленное тело не держит сокет
 * и память пять минут — умолчание node). Таймауты http.Server: заголовки — HEADERS_TIMEOUT_MS,
 * запрос целиком — REQUEST_TIMEOUT_MS (node сам отвечает 408). Ответ (поток SSE команды)
 * под них не попадает: requestTimeout node считает только до конца приёма запроса.
 */
export const BODY_TIMEOUT_MS = 30000;
export const HEADERS_TIMEOUT_MS = 20000;
export const REQUEST_TIMEOUT_MS = 35000;

/** Ждущих команд на проект (кроме выполняемой). Больше — 429 busy. */
export const MAX_QUEUE_PER_PROJECT = 4;

/** Сколько живут посчитанные варианты в ожидании /agent/apply. */
export const VARIANTS_TTL_MS = 15 * 60 * 1000;
/** Сколько наборов вариантов держим в памяти всего (старые вытесняются). */
export const MAX_VARIANT_SETS = 200;

/** Форма команды. */
export const MAX_TEXT = 5000;
export const MAX_ID = 128;
export const MAX_SELECTION = 2000;
export const MAX_HISTORY = 5;
export const MAX_HISTORY_CHARS = 500;
export const MAX_AUTHOR = 200;
export const MAX_VARIANTS = 6;

/** Сеть до Document service. */
export const DOC_TIMEOUT_MS = 10000;
export const DOC_HEALTH_TIMEOUT_MS = 1500;
/**
 * Круг 39 (N5а): проверка здоровья перед командой не уложилась в DOC_HEALTH_TIMEOUT_MS — ещё одна,
 * подольше: под нагрузкой сервис отвечает медленно, но жив. Не ответил и тогда — 503 `busy`
 * («перегружен»), а не `document_down`. /agent/health так не ждёт.
 */
export const DOC_HEALTH_PATIENT_MS = 5000;
/** Круг 39: сервис ответил (не 5xx) не раньше этого — его молчание на /api/health не значит «недоступен». */
export const DOC_RECENT_OK_MS = 5000;
/**
 * Круг 39 (N5а): таймер дедлайна опоздал больше этого — занят был наш цикл событий, а не
 * сервис: срок продлевается (не больше LOOP_LAG_EXTENSIONS раз), ответ успевает прийти.
 */
export const LOOP_LAG_GRACE_MS = 100;
export const LOOP_LAG_EXTENSIONS = 3;
/**
 * Круг 39 (N5а): полные чтения стейта у Document service (снимок + хвост: на 14 тыс. узлов —
 * 3,6 МБ JSON, в памяти — в разы больше). Шторм из 30 команд в 30 больших проектов разом читал
 * всё сразу: пик памяти агента ~0,9 ГБ, главный поток занят разбором, и проверки здоровья
 * опаздывали — ложное «Сервис документов недоступен». Теперь полные чтения — под семафором:
 *   • одновременно — не больше DSLR_FULL_CONCURRENCY;
 *   • и по байтам: документы, прочитанные целиком и ещё нужные командам (до конца расчёта), —
 *     не больше DSLR_FULL_BYTES (длина JSON); один документ больше предела читается, когда
 *     других нет; размер ещё не читанного проекта — последний известный, иначе
 *     DSLR_READ_ESTIMATE_BYTES;
 *   • ждущих — не больше DSLR_FULL_QUEUE (сверх — сразу 503 busy), ждущим — событие
 *     `queued {scope:'read', position}`;
 *   • срок одного полного чтения — DOC_FULL_TIMEOUT_MS; всё чтение стейта (очередь, повторы по
 *     таймауту, ожидания по Retry-After) — в бюджете DSLR_READ_BUDGET_MS, сверх — 503 `busy`.
 */
export const DSLR_FULL_CONCURRENCY = 4;
export const DSLR_FULL_BYTES = 64 * 1024 * 1024;
export const DSLR_READ_ESTIMATE_BYTES = 1024 * 1024;
export const DSLR_FULL_QUEUE = 64;
export const DOC_FULL_TIMEOUT_MS = 30000;
export const DSLR_READ_BUDGET_MS = 60000;
/**
 * Круг 41 (D5): ожидание в СВОЕЙ очереди полных чтений — отдельно от бюджета ответа сервиса
 * (DSLR_READ_BUDGET_MS считается с мига, когда чтение получило место). Срок щедрый: очередь
 * движется, пока команды впереди досчитывают; клиент о ней знает (`queued {scope:'read'}`), а
 * пульс SSE держит поток. Не дождалась — 503 `busy` с причиной `agent`.
 */
export const DSLR_QUEUE_WAIT_MS = 180000;
/** Круг 39: повторов чтения после таймаута (в пределах бюджета). */
export const DSLR_TIMEOUT_RETRIES = 1;
/** Круг 39: сколько проектов помнить по размеру (для оценки до чтения). */
export const DSLR_SIZE_MEMO = 4096;
export const WRITE_ATTEMPTS = 3;
/**
 * 503 сервиса документов с `Retry-After` (семафор тяжёлых чтений, база недоступна): ждём
 * указанный срок, но не дольше этого — команда не должна висеть минутами.
 */
export const DOC_RETRY_AFTER_MAX_S = 5;
/**
 * Запись: суммарное ожидание повторов на одну транзакцию — и по Retry-After, и (круг 27) при
 * отказе соединения: Document service перезапускается ~3 с, и работа модели за это время
 * не должна теряться. Повторы идут с тем же tx_id — двойной записи не бывает.
 */
export const WRITE_WAIT_BUDGET_MS = 15000;
/** Круг 27: пауза между повторами записи при отказе сети — растёт до этого потолка. */
export const WRITE_BACKOFF_MAX_MS = 2000;
/**
 * Пределы транзакции Document service (SPEC §9.8, `server/document/limits.js` —
 * MAX_OPS_PER_TX, MAX_BODY_BYTES). Образ агента server/document не содержит, поэтому
 * числа повторены здесь; test/orchestrator/dslr.test.mjs сверяет их с сервисом.
 * Правку больше предела агент не пишет вовсе (никакой частичной записи): ошибка
 * `too_large` с объяснением человеку.
 */
export const DOC_MAX_OPS_PER_TX = 5000;
export const DOC_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Страница журнала, которую просим (сервис режет ещё и по байтам; конец — по `more`). */
export const DOC_PAGE_LIMIT = 5000;
/** Страниц на одно дочитывание — страховка от бесконечного цикла. */
export const DSLR_MAX_PAGES = 2000;
/** Сколько раз подряд читать стейт целиком, если журнал переписывается прямо под чтением. */
export const DSLR_FULL_ATTEMPTS = 3;
/** Сеть до модели: проверка здоровья. */
export const LLM_HEALTH_TIMEOUT_MS = 3000;
export const LLM_HEALTH_CACHE_MS = 10000;

/** DSLV: пул воркеров. */
export const WORKER_MAX_OLD_MB = 512;
/** Счётное время одного прогона (ожидание модели не считается). */
export const WORKER_TIMEOUT_MS = 60000;
/**
 * Круг 27: заданий на один воркер одновременно. Воркер не простаивает, пока задание ждёт
 * модель: он берёт следующее (считает всегда одно — поток один, — а ждущие модель стоят).
 * Новое задание воркер получает, только когда ни одно из его заданий не считает.
 */
export const WORKER_JOBS_MAX = 4;
/** Круг 27: очередь пула (все воркеры заняты счётом или полны) — не длиннее и не дольше. */
export const POOL_QUEUE_MAX = 32;
export const POOL_QUEUE_WAIT_MS = 30000;

/** Кеш стейтов DSLR: проектов в памяти. */
export const DSLR_CACHE_PROJECTS = 64;
/**
 * Круг 25: и по байтам — оценка JSON документов в кеше. Документ бывает до 24 МиБ JSON
 * (§9.8), в памяти объектами — в разы больше; 64 таких — гигабайты. Самый давний
 * вытесняется, пока сумма больше предела (последний прочитанный остаётся всегда).
 */
export const DSLR_CACHE_BYTES = 96 * 1024 * 1024;
/** DUIL: библиотек на команду и время жизни списка проектов. */
export const MAX_LIBRARIES = 8;
/** Круг 25: список библиотек — не чаще раза в 30 с (свежесть самих библиотек — по их журналу). */
export const PROJECT_LIST_TTL_MS = 30000;
/** Список не прочитался — прежний годится ещё столько. */
export const PROJECT_LIST_STALE_MS = 10 * 60 * 1000;

/** Трассы в памяти (последние N) — для отладки и тестов. */
export const TRACE_RING = 100;

/**
 * Остановка (круг 25): Docker шлёт SIGKILL через 10 с после SIGTERM, поэтому весь останов
 * укладывается в SHUTDOWN_HARD_MS = 8 с: выполняемой команде — дедлайн SHUTDOWN_GRACE_MS
 * (успела — записана), потом отмена и не больше SHUTDOWN_ABORT_WAIT_MS на то, чтобы она
 * свернулась; трассам — SHUTDOWN_FLUSH_MS. Не уложились — выход с кодом 1 по таймеру.
 */
export const SHUTDOWN_GRACE_MS = 5000;
export const SHUTDOWN_ABORT_WAIT_MS = 1500;
export const SHUTDOWN_FLUSH_MS = 1000;
export const SHUTDOWN_HARD_MS = 8000;

/** Пульс SSE, чтобы прокси не рвал простаивающий поток. */
export const SSE_PING_MS = 15000;
