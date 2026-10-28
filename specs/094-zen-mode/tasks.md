# Задачи круга 94

- [x] T1 `src/shell.js`: команда `zen` в `SHELL_COMMANDS`, фразы `RE_ZEN_ON/OFF`, `/зен [вкл|выкл]`, `commandIdOf`, `shellIntentFromServer`
- [x] T2 `index.html`: `btn-zen`, `zenbar` (статус, «Выйти»), `btn-zen-mic`
- [x] T3 `styles.css`: блок зен-режима (колонки, скрытие, статус, микрофон)
- [x] T4 `app.js`: `setZen`/`applyZen`/`renderZenStatus`/`renderZenMic`, клавиши, `applyShellIntent`, `showMsg` → статус, палитра выводит
- [x] T5 `test/zen-r94.test.mjs`: слова, разметка, Chromium-сценарий с голосом
- [x] T6 SPEC §24 и строка в §13.6
- [x] T7 сайдкары; `node tools/sidecars.mjs --changed origin/imago-studio`
- [x] T8 полный `npm test` с Postgres; скриншоты владельцу
