// @ts-check
/**
 * Link — модель одного направления канала (SPEC §7.1).
 *
 * Два этапа, как у netem `rate` + `delay`:
 *   1. пейсинг по token bucket (полоса): сегмент уходит, когда в ведре хватает байт;
 *   2. односторонняя задержка распространения: сегмент доставляется через `delayMs` после ухода.
 * Очередь FIFO на всё направление (одна «труба» на все соединения), порядок сохраняется
 * и при живой смене параметров (момент доставки монотонный).
 *
 * Время — `performance.now()` (мс, дробное); таймеры Node имеют ~1 мс гранулярность,
 * поэтому большие chunk'и режутся на сегменты `segmentBytes`, а опоздание таймера
 * компенсируется накоплением токенов (не больше ёмкости ведра).
 */

import { performance } from 'node:perf_hooks';

/**
 * Ёмкость token bucket по умолчанию, мс передачи. 20 мс при 20 Мбит/с ≈ 50 КБ: страница из 500 фигур
 * (≈117 КБ JSON) не проходит одним всплеском, а пейсится полосой; при прежних 40 мс (≈100 КБ) она
 * уходила почти нешейпленной (docs/INTEGRATION.md §5).
 */
export const DEFAULT_BUCKET_MS = 20;

/**
 * @typedef {object} LinkConfig
 * @property {number} delayMs          односторонняя задержка, мс
 * @property {number} bandwidthMbit    полоса, Мбит/с; 0 или Infinity — без ограничения
 * @property {number} [bucketMs]       ёмкость ведра в миллисекундах передачи (по умолчанию 20 → ≈50 КБ при 20 Мбит/с)
 * @property {number} [segmentBytes]   максимальный сегмент (по умолчанию 4096)
 */

/** @typedef {(chunk: Buffer | null) => void} Deliver */

/**
 * @typedef {object} QueueItem
 * @property {Buffer | null} chunk   null — управляющий маркер (0 байт)
 * @property {Deliver} deliver
 */

/**
 * @typedef {object} DelayItem
 * @property {number} at
 * @property {Buffer | null} chunk
 * @property {Deliver} deliver
 */

export class Link {
  /**
   * @param {string} name
   * @param {LinkConfig} config
   */
  constructor(name, config) {
    this.name = name;
    this.delayMs = 0;
    /** байт/мс; Infinity — без ограничения */
    this.bytesPerMs = Infinity;
    this.bucketBytes = Infinity;
    this.bucketMs = config.bucketMs ?? DEFAULT_BUCKET_MS;
    this.segmentBytes = config.segmentBytes ?? 4096;
    this.tokens = 0;
    this.limited = false;
    this.lastRefill = performance.now();
    /** @type {QueueItem[]} */
    this.paceQueue = [];
    this.paceHead = 0;
    /** @type {DelayItem[]} */
    this.delayQueue = [];
    this.delayHead = 0;
    this.lastAt = 0;
    /** @type {NodeJS.Timeout | null} */
    this.paceTimer = null;
    /** @type {NodeJS.Timeout | null} */
    this.delayTimer = null;
    /** @type {NodeJS.Immediate | null} */
    this.delayImmediate = null;
    /** байты, ещё не доставленные (в обеих очередях) */
    this.pendingBytes = 0;
    this.deliveredBytes = 0;
    this.closed = false;
    this.configure(config);
  }

  /** @param {Partial<LinkConfig>} cfg */
  configure(cfg) {
    if (cfg.delayMs !== undefined) this.delayMs = Math.max(0, Number(cfg.delayMs) || 0);
    if (cfg.bucketMs !== undefined) this.bucketMs = Math.max(1, Number(cfg.bucketMs) || DEFAULT_BUCKET_MS);
    if (cfg.bandwidthMbit !== undefined) {
      const mbit = Number(cfg.bandwidthMbit);
      if (!mbit || !Number.isFinite(mbit) || mbit <= 0) {
        this.bytesPerMs = Infinity;
        this.bucketBytes = Infinity;
      } else {
        this.bytesPerMs = (mbit * 1e6) / 8 / 1000;
        this.bucketBytes = Math.max(this.segmentBytes, this.bytesPerMs * this.bucketMs);
      }
    }
    // ведро: при первом включении ограничения — полное, при смене полосы — не больше новой ёмкости
    if (!Number.isFinite(this.bucketBytes)) this.tokens = 0;
    else if (!this.limited) this.tokens = this.bucketBytes;
    else this.tokens = Math.min(this.tokens, this.bucketBytes);
    this.limited = Number.isFinite(this.bucketBytes);
    this.lastRefill = performance.now();
    this._pump();
  }

  get config() {
    return {
      delayMs: this.delayMs,
      bandwidthMbit: Number.isFinite(this.bytesPerMs) ? (this.bytesPerMs * 8 * 1000) / 1e6 : 0,
      bucketMs: this.bucketMs,
      segmentBytes: this.segmentBytes,
    };
  }

  /**
   * Поставить данные в очередь направления. Chunk режется на сегменты; `deliver`
   * вызывается для каждого сегмента в порядке очереди после пейсинга и задержки.
   * @param {Buffer} chunk
   * @param {Deliver} deliver
   */
  send(chunk, deliver) {
    if (this.closed) return;
    for (let off = 0; off < chunk.length; off += this.segmentBytes) {
      const seg = off === 0 && chunk.length <= this.segmentBytes ? chunk : chunk.subarray(off, off + this.segmentBytes);
      this.paceQueue.push({ chunk: seg, deliver });
      this.pendingBytes += seg.length;
    }
    this._pump();
  }

  /**
   * Управляющий маркер (0 байт): доставляется строго после всего, что было поставлено раньше.
   * Используется для end/close, чтобы «хвост» данных не терялся.
   * @param {() => void} fn
   */
  marker(fn) {
    if (this.closed) return;
    this.paceQueue.push({ chunk: null, deliver: () => fn() });
    this._pump();
  }

  _refill() {
    const now = performance.now();
    if (Number.isFinite(this.bytesPerMs)) {
      const dt = now - this.lastRefill;
      this.tokens = Math.min(this.bucketBytes, this.tokens + dt * this.bytesPerMs);
    }
    this.lastRefill = now;
    return now;
  }

  /** Этап 1: выпуск сегментов из очереди пейсинга по токенам. */
  _pump() {
    if (this.paceTimer) {
      clearTimeout(this.paceTimer);
      this.paceTimer = null;
    }
    const now = this._refill();
    const unlimited = !Number.isFinite(this.bytesPerMs);
    while (this.paceHead < this.paceQueue.length) {
      const item = this.paceQueue[this.paceHead];
      const len = item.chunk ? item.chunk.length : 0;
      if (!unlimited && len > 0 && this.tokens < len) {
        const waitMs = (len - this.tokens) / this.bytesPerMs;
        this.paceTimer = setTimeout(() => {
          this.paceTimer = null;
          this._pump();
        }, Math.max(1, Math.ceil(waitMs)));
        break;
      }
      if (!unlimited) this.tokens -= len;
      this.paceHead++;
      const at = Math.max(now + this.delayMs, this.lastAt);
      this.lastAt = at;
      this.delayQueue.push({ at, chunk: item.chunk, deliver: item.deliver });
    }
    if (this.paceHead > 1024 && this.paceHead * 2 > this.paceQueue.length) {
      this.paceQueue = this.paceQueue.slice(this.paceHead);
      this.paceHead = 0;
    }
    this._scheduleDelivery();
  }

  /** Этап 2: доставка по достижении момента `at`. */
  _scheduleDelivery() {
    if (this.delayTimer || this.delayImmediate || this.delayHead >= this.delayQueue.length) return;
    const head = this.delayQueue[this.delayHead];
    const wait = head.at - performance.now();
    if (wait <= 0.25) {
      // доставляем асинхронно, но без лишнего ожидания
      this.delayImmediate = setImmediate(() => {
        this.delayImmediate = null;
        this._deliverDue();
      });
      return;
    }
    this.delayTimer = setTimeout(() => {
      this.delayTimer = null;
      this._deliverDue();
    }, Math.ceil(wait));
  }

  _deliverDue() {
    const now = performance.now() + 0.25;
    while (this.delayHead < this.delayQueue.length) {
      const item = this.delayQueue[this.delayHead];
      if (item.at > now) break;
      this.delayHead++;
      if (item.chunk) {
        this.pendingBytes -= item.chunk.length;
        this.deliveredBytes += item.chunk.length;
      }
      try {
        item.deliver(item.chunk);
      } catch (err) {
        // ошибка получателя не должна ломать канал
        process.emitWarning(`netshaper link ${this.name}: deliver failed: ${/** @type {Error} */ (err)?.message}`);
      }
    }
    if (this.delayHead > 1024 && this.delayHead * 2 > this.delayQueue.length) {
      this.delayQueue = this.delayQueue.slice(this.delayHead);
      this.delayHead = 0;
    }
    this._scheduleDelivery();
  }

  /** Остановить таймеры (для тестов/закрытия). Недоставленные данные отбрасываются. */
  close() {
    this.closed = true;
    if (this.paceTimer) clearTimeout(this.paceTimer);
    if (this.delayTimer) clearTimeout(this.delayTimer);
    if (this.delayImmediate) clearImmediate(this.delayImmediate);
    this.paceTimer = null;
    this.delayTimer = null;
    this.delayImmediate = null;
    this.paceQueue = [];
    this.delayQueue = [];
    this.paceHead = this.delayHead = 0;
  }
}
