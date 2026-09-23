// @ts-check
/**
 * ShapedSocket — Duplex-обёртка над клиентским TCP-сокетом.
 *
 * Всё, что браузер прислал (raw.data), проходит через Link «inbound» и только потом
 * становится доступно читателю (HTTP-парсеру Node или трубе WebSocket). Всё, что
 * пишут в обёртку, проходит через Link «outbound» и лишь потом уходит в raw-сокет.
 * Байты считаются на raw-сокете: bytesIn — принято от браузера, bytesOut — отправлено ему.
 *
 * Объект подсовывается `http.Server` через `server.emit('connection', shaped)` — это
 * документированный способ инъекции Duplex-потока; методы `setTimeout`/`destroySoon`
 * реализованы, поскольку http.Server вызывает их при наличии.
 */

import { Duplex } from 'node:stream';
import { Link } from './link.mjs';

/**
 * @typedef {object} ByteSink
 * @property {(n: number) => void} onIn   принято от клиента
 * @property {(n: number) => void} onOut  отправлено клиенту
 */

export class ShapedSocket extends Duplex {
  /**
   * @param {import('node:net').Socket} raw
   * @param {{ inbound: Link, outbound: Link }} links
   * @param {ByteSink} sink
   * @param {{ inflightLimit?: number, handshakeRttMs?: number }} [opts]
   */
  constructor(raw, links, sink, opts = {}) {
    super({ allowHalfOpen: true, readableHighWaterMark: 256 * 1024, writableHighWaterMark: 256 * 1024 });
    this.raw = raw;
    this.links = links;
    this.sink = sink;
    this.inflightLimit = opts.inflightLimit ?? 1024 * 1024;
    /** байты, принятые от клиента и ещё не доставленные читателю */
    this.inflightIn = 0;
    /** байты, записанные в обёртку и ещё не ушедшие в raw-сокет */
    this.inflightOut = 0;
    /** @type {null | (() => void)} */
    this.pendingWriteCb = null;
    this.rawEnded = false;
    this.rawClosed = false;
    this.dead = false;
    this.wantRead = false;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this._idleTimer = /** @type {NodeJS.Timeout | null} */ (null);
    this._idleMs = 0;
    this._readPaused = false;

    // адресные свойства — для логов/заголовков X-Forwarded-For
    this.remoteAddress = raw.remoteAddress;
    this.remotePort = raw.remotePort;
    this.remoteFamily = raw.remoteFamily;
    this.localAddress = raw.localAddress;
    this.localPort = raw.localPort;
    this.encrypted = false;

    raw.setNoDelay(true);
    raw.on('data', (chunk) => this._onRawData(chunk));
    raw.on('end', () => {
      this.rawEnded = true;
      this.links.inbound.marker(() => {
        if (!this.dead) this.push(null);
      });
    });
    raw.on('error', (err) => this.destroy(err));
    raw.on('close', () => {
      this.rawClosed = true;
      // закрываем обёртку после доставки всего, что клиент успел прислать
      this.links.inbound.marker(() => {
        if (!this.dead) this.destroy();
      });
    });
    raw.on('drain', () => this._maybeWriteCb());

    if (opts.handshakeRttMs && opts.handshakeRttMs > 0) {
      // эмуляция TCP-рукопожатия через задержанный канал: первые байты клиента
      // «прибывают» на RTT позже (SYN/SYN-ACK шли бы по тому же каналу)
      raw.pause();
      const t = setTimeout(() => {
        if (!this.dead && !this.rawClosed && !this._readPaused) raw.resume();
      }, opts.handshakeRttMs);
      t.unref();
    }
  }

  /** @param {Buffer} chunk */
  _onRawData(chunk) {
    this._touch();
    this.bytesRead += chunk.length;
    this.sink.onIn(chunk.length);
    this.inflightIn += chunk.length;
    if (this.inflightIn > this.inflightLimit && !this._readPaused) {
      this._readPaused = true;
      this.raw.pause();
    }
    this.links.inbound.send(chunk, (seg) => {
      if (!seg) return;
      this.inflightIn -= seg.length;
      if (this.dead) return;
      const more = this.push(seg);
      if (!more) this.wantRead = false;
      this._maybeResumeRaw();
    });
  }

  _maybeResumeRaw() {
    if (this._readPaused && this.wantRead && this.inflightIn < this.inflightLimit / 2) {
      this._readPaused = false;
      this.raw.resume();
    }
  }

  _read() {
    this.wantRead = true;
    this._maybeResumeRaw();
  }

  /**
   * @param {Buffer} chunk
   * @param {BufferEncoding} _enc
   * @param {(err?: Error | null) => void} cb
   */
  _write(chunk, _enc, cb) {
    if (this.dead) return cb();
    this._touch();
    this.inflightOut += chunk.length;
    this.links.outbound.send(chunk, (seg) => {
      if (!seg) return;
      this.inflightOut -= seg.length;
      if (this.dead || this.raw.destroyed) return;
      this.raw.write(seg);
      this.bytesWritten += seg.length;
      this.sink.onOut(seg.length);
      this._maybeWriteCb();
    });
    this.pendingWriteCb = cb;
    this._maybeWriteCb();
  }

  _maybeWriteCb() {
    const cb = this.pendingWriteCb;
    if (!cb) return;
    if (this.dead || (this.inflightOut <= this.inflightLimit && !this.raw.writableNeedDrain)) {
      this.pendingWriteCb = null;
      cb();
    }
  }

  /** @param {(err?: Error | null) => void} cb */
  _final(cb) {
    this.links.outbound.marker(() => {
      if (this.dead || this.raw.destroyed || !this.raw.writable) return cb();
      // FIN уходит после всего «хвоста»; finish обёртки — после фактического shutdown raw
      this.raw.end(() => cb());
    });
  }

  /**
   * @param {Error | null} err
   * @param {(err?: Error | null) => void} cb
   */
  _destroy(err, cb) {
    this.dead = true;
    this._clearIdle();
    const finish = () => {
      if (!this.raw.destroyed) this.raw.destroy();
      cb(err);
    };
    if (err || this.rawClosed || this.raw.destroyed) return finish();
    // мягкое уничтожение: дать «хвосту» исходящих данных уйти по каналу, затем FIN и close
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        finish();
      }
    }, 5000);
    t.unref();
    const tail = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (this.raw.destroyed || !this.raw.writable) return finish();
      this.raw.end(() => finish());
    };
    if (this.inflightOut > 0) this.links.outbound.marker(tail);
    else tail();
  }

  /** net.Socket API, ожидаемое http.Server */
  destroySoon() {
    if (this.writable) this.end();
    if (this.writableFinished) this.destroy();
    else this.once('finish', () => this.destroy());
  }

  /**
   * @param {number} ms
   * @param {() => void} [cb]
   */
  setTimeout(ms, cb) {
    this._idleMs = ms;
    if (cb) this.once('timeout', cb);
    this._touch();
    return this;
  }

  _touch() {
    this._clearIdle();
    if (this._idleMs > 0) {
      this._idleTimer = setTimeout(() => {
        this._idleTimer = null;
        this.emit('timeout');
      }, this._idleMs);
      this._idleTimer.unref();
    }
  }

  _clearIdle() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  setNoDelay() {
    return this;
  }

  setKeepAlive() {
    return this;
  }

  ref() {
    this.raw.ref();
    return this;
  }

  unref() {
    this.raw.unref();
    return this;
  }

  address() {
    return this.raw.address();
  }
}
