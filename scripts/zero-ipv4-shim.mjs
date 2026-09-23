// Обход отсутствия IPv6 в песочнице: zero-cache 1.9.0 жёстко вызывает `listen({host: '::'})`
// для всех своих HTTP-сервисов (dispatcher :4848, change-streamer :4849, ...), а в контейнере
// `::` даёт EAFNOSUPPORT. Подключается во все процессы zero-cache через
// NODE_OPTIONS=--import=<этот файл> (воркеры наследуют env) и подменяет '::' → '127.0.0.1'.
//
// Именно 127.0.0.1, а НЕ 0.0.0.0 (§1.6: административные интерфейсы — только внутри контура).
// `::` у zero-cache означает «все интерфейсы», и подстановка 0.0.0.0 сохраняла это свойство:
// :4848 вместе с /statz, /heapz и inspector был доступен снаружи машины. Клиент ходит в
// zero-cache через шейпер (127.0.0.1:8080/zero), API — через 127.0.0.1, поэтому привязка к петле
// достаточна. Переопределяется STAND_ZERO_BIND_HOST (например, 0.0.0.0 внутри сети Compose).
import net from 'node:net';

const HOST = process.env.STAND_ZERO_BIND_HOST || '127.0.0.1';

const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
  if (args.length && typeof args[0] === 'object' && args[0] !== null && args[0].host === '::') {
    args[0] = { ...args[0], host: HOST };
  } else if (typeof args[0] === 'number' && args[1] === '::') {
    args[1] = HOST;
  }
  return origListen.apply(this, args);
};
