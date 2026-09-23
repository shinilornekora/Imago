# Функциональные проверки (SPEC §6, таблица 1)

* Начало: 2026-09-13T00:32:40.296Z, конец: 2026-09-13T00:33:18.149Z
* API: http://127.0.0.1:3011; документ: `doc-acc-50x500` (data/acceptance.json); документ bob: `doc-bob-5x50`
* Профиль документа: doc-acc-50x500: 50 страниц × 500 фигур; источник проверок doc-acc-50x500-src-1 (100 экземпляров на 10 страницах, непереопределённые на 10); библиотечная страница doc-acc-50x500-p50
* Набор проверок: 1-open, 3-source-fill, 4-late-nav, 5-stale-read, 6-retry — **частичный набор** (`--only`), полного допуска этот прогон не даёт
* Итого строк: pass 4, fail 6, skip 0, n/a 0
* **Допуск** (все применимые проверки полного набора пройдены): —
* **Не допущены**: Z/P/cache=1, Z/F

## Сводка по конфигурациям

| Конфигурация | 1-open | 3-source-fill | 4-late-nav | 5-stale-read | 6-retry | Вердикт |
|---|---|---|---|---|---|---|
| Z/P/cache=1 | ✅ | ✅ | ❌ | ❌ | ❌ | **не допущено** |
| Z/F | ✅ | ❌ | ❌ | ❌ | ✅ | **не допущено** |

Обозначения: ✅ пройдена, ❌ провал, ⏭ пропущена (`skip` — допуска не даёт, причина ниже), `n/a` неприменима (обоснование ниже), — не запускалась.

## Оговорки и неприменимые проверки

* **Z/P/cache=1** — не допущено
* **Z/F** — не допущено

## Все строки (конфигурация × проверка)

| Конфигурация | Проверка | Исход | Сообщение | мс |
|---|---|---|---|---|
| Z/P/cache=1 | 1. Открытие страницы | pass | p1: 500 фигур, ревизия 0, зонд 107 опросов без частичных снимков; p2: 500 фигур, зонд 40 опросов; P (Z, WebSocket, без хука задержки): снимок null и state=loading до полного набора (266 мс); холст: 65 цветов | 1291 |
| Z/P/cache=1 | 3. Общая заливка источника | pass | setSourceFill(doc-acc-50x500-src-1, #aa00aa) с активной doc-acc-50x500-p2: affectedPages=10 (незагруженных до команды: 9), affectedShapes=81; compare-db + operations ok; снимок doc-acc-50x500-p2 = эталон | 2202 |
| Z/P/cache=1 | 4. Поздний переход | fail | page.evaluate: ApiHttpError: operation "5023d030-668b-4659-8d09-eda4768eefa0" not found \|     at je (http://127.0.0.1:3011/assets/index-Bcyc_g5P.js:10:63790) \|     at async yC.fetchOperationResult (http://127.0.0.1:3011/assets/z-D2vuQcXb.js:8:29094) \|     at async yC.runCommand (http://127.0.0.1: | 3386 |
| Z/P/cache=1 | 5. Ответ старого чтения | fail | к моменту команды doc-acc-50x500-p2 ещё не доставлена | 1164 |
| Z/P/cache=1 | 6. Повтор команды | fail | журнал операций пуст после сброса \|  \| 3 !== 0 \|  | 1158 |
| Z/F | 1. Открытие страницы | pass | p1: 500 фигур, ревизия 0, зонд 126 опросов без частичных снимков; p2: 500 фигур, зонд 7 опросов; холст: 65 цветов | 1451 |
| Z/F | 3. Общая заливка источника | fail | page.evaluate: ApiHttpError: expected revision 1, current is 0 \|     at _C (http://127.0.0.1:3011/assets/z-D2vuQcXb.js:8:19241) \|     at yC.runCommand (http://127.0.0.1:3011/assets/z-D2vuQcXb.js:8:22886) \|     at async Ge.runCommand (http://127.0.0.1:3011/assets/index-Bcyc_g5P.js:10:69180) \|     | 6632 |
| Z/F | 4. Поздний переход | fail | page.evaluate: ApiHttpError: expected revision 1, current is 0 \|     at _C (http://127.0.0.1:3011/assets/z-D2vuQcXb.js:8:19241) \|     at yC.runCommand (http://127.0.0.1:3011/assets/z-D2vuQcXb.js:8:22886) \|     at async Ge.runCommand (http://127.0.0.1:3011/assets/index-Bcyc_g5P.js:10:69180) \|     | 7723 |
| Z/F | 5. Ответ старого чтения | fail | команда оболочки (HTTP, alice): 409 {"error":"revision_mismatch","message":"expected revision 0, current is 1","currentRevision":1} \|  \| 409 !== 200 \|  | 921 |
| Z/F | 6. Повтор команды | pass | Z А: офлайн 707 мс до отправки → доставлено после восстановления (.server через 1347 мс), 1 строка, rev 0→1; Б: офлайн 700 мс после command-sent → .server через 983 мс, 1 строка, rev → 2; compare-db ok; retry-события: нет | 10068 |
