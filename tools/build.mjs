import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const body = readFileSync(join(root, 'index.html'), 'utf8');

function fullDoc({ head = '', top = '' } = {}) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>[hidden]{display:none!important}img{max-width:100%}</style>
${head}</head>
<body style="margin:0">
${top}${body}</body>
</html>
`;
}

/* 1) dev.html — прогон в браузере с заглушкой платформы */
writeFileSync(join(root, 'dev.html'), fullDoc({ top: '<script src="tools/stub.js"></script>\n' }), 'utf8');

/* 2) dist/local — локальная сборка: голос + LM Studio */
const dist = join(root, 'dist', 'local');
mkdirSync(join(dist, 'src'), { recursive: true });

const defaults = `<script>
  window.IMAGO_DEFAULTS = { lmstudio: { enabled: true, baseUrl: 'http://localhost:1234/v1', model: 'local-model' } };
</script>
`;
writeFileSync(join(dist, 'index.html'), fullDoc({ top: defaults }), 'utf8');
for (const f of ['styles.css', 'app.js']) copyFileSync(join(root, f), join(dist, f));
for (const f of ['core.js', 'brain.js', 'sync.js']) copyFileSync(join(root, 'src', f), join(dist, 'src', f));

writeFileSync(join(dist, 'START.cmd'), [
  '@echo off',
  'setlocal',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  'set "PORT=8123"',
  '',
  'set "RUNNER="',
  'where py >nul 2>&1 && set "RUNNER=py -3 -m http.server %PORT%"',
  'if not defined RUNNER where python >nul 2>&1 && set "RUNNER=python -m http.server %PORT%"',
  'if not defined RUNNER where node >nul 2>&1 && set "RUNNER=node server.mjs %PORT%"',
  '',
  'if not defined RUNNER (',
  '  echo.',
  '  echo Нужен Python или Node.js: без них статический сервер не поднять.',
  '  echo Поставьте Python с python.org и запустите этот файл снова.',
  '  echo.',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'echo Imago Studio: http://localhost:%PORT%/',
  'echo Окно закрывать после работы — оно и есть сервер.',
  'start "" "http://localhost:%PORT%/"',
  '%RUNNER%',
  '',
].join('\r\n'), 'utf8');

writeFileSync(join(dist, 'server.mjs'), `import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = Number(process.argv[2] || 8123);
const dir = new URL('.', import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, '$1');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = normalize(url === '/' ? '/index.html' : url).replace(/^([/\\\\]\\.\\.)+/, '');
    const file = join(dir, rel);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}).listen(port, () => console.log('http://localhost:' + port + '/'));
`, 'utf8');

writeFileSync(join(dist, 'ЧИТАТЬ.txt'), `Imago Studio — локальная сборка
================================

Запуск
------
1. Двойной клик по START.cmd. Откроется http://localhost:8123/.
   (Нужен Python или Node.js — только чтобы отдать файлы по http;
   через file:// модули браузер не пустит.)
2. Окно консоли не закрывать, пока работаете: это и есть сервер.

Голос
-----
Кнопка с микрофоном слева в командной строке: клик включает и выключает,
удержание на самой кнопке — «говорю, пока держу». С клавиатуры — латинская V.
(Пробел занят панорамой холста, поэтому под диктовку он не отдан.)
Пока микрофон открыт, командная строка и подсказки убираются с экрана —
макет ничем не заслонён. В правом нижнем углу горит значок микрофона, а над
ним тихим шрифтом видно то, что вы наговариваете. Вернуться к печати: тот же
значок, клавиша V или Esc.
По умолчанию — одна команда за нажатие: после отправки микрофон выключается
сам, и он же выключится после 10 секунд тишины. Режим «слушать постоянно»
включается в настройках (шестерёнка → «Голос») — тогда команда уходит через
1.2 секунды тишины и фразу можно договорить с паузой.
Если агент ещё занят, приложение спросит: заменить команду, поставить
в очередь или отменить новую; ответить можно голосом.

Голосом (и набранной строкой) работают команды самому редактору — они
выполняются мгновенно, до обращения к модели, и без подключённой модели тоже:
  «стоп» — прервать агента
  «отмена», «отмени», «верни как было», «назад» — откатить последнюю правку
  «отмени два раза» — откатить сразу несколько
  «верни обратно», «вперёд» — вернуть отменённое
  «первый», «второй», «третий», «возьми этот» — выбрать вариант
  «покажи три варианта», «а по-другому» — посчитать варианты
  «покажи сводку недели», «следующая доска», «вторая доска» — переключить доску
  «новая доска», «создай доску» — пустая доска, мгновенно
  «вписать», «вписать всё», «приблизь», «масштаб 100» — вид
  «выдели карточку встречи», «сними выделение» — выделение
  «экспортируй png», «сохрани svg», «экспорт» — файлы
  «история», «диалог», «настройки», «закрой слои» — панели
Доска, которую вы видите, задаёт область работы агента: переключив доску
голосом, вы говорите агенту, где работать. Новую доску даёт «+» в ряду
вкладок наверху.

Работает в Chrome и Edge (Web Speech API, язык ru-RU); в Firefox нет.
Распознавание идёт через сервис браузера, то есть звук уходит наружу —
это ограничение Chrome, не приложения.

Модель
------
По умолчанию агент ждёт LM Studio на http://localhost:1234/v1.
В LM Studio: вкладка Developer → Start Server, загрузить модель,
включить "Serve on Local Network" не нужно.
Адрес и имя модели меняются в приложении: шестерёнка → «Агент».

Что умеет
---------
• Команда текстом или голосом: «экран оплаты с полем карты и итогом».
• Три варианта одной командой — кнопка «3 варианта».
• Правка выделенного: «сделай заголовок крупнее», «разложи в строку».
• Мышь: тянуть, менять размер, двойной клик по тексту — правка на месте.
• Ctrl+Z / Ctrl+Shift+Z, история правок (кнопка «История»).
• Экспорт: PNG, SVG, JSON. Импорт JSON — там же.
• Документ сохраняется сам в браузере (localStorage).

Горячие клавиши
---------------
/ или Ctrl+K — командная строка      H — история
V — голосовая команда                L — панель слоёв
Ctrl+Z / Ctrl+Shift+Z — отмена       Delete — удалить
Ctrl+D — дублировать                 Space+мышь — панорама
1…9 — выбрать вариант, когда открыта панель вариантов
Колесо — зум, Ctrl+колесо — зум к курсору
`, 'utf8');

console.log('built: dev.html, dist/local (index.html, START.cmd, server.mjs, ЧИТАТЬ.txt)');
