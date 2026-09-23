import type { CommandResult } from '@stand/shared';

/**
 * Учёт ревизии документа на клиенте (общий для H и Q).
 *
 * Ревизия документа — единственный источник истины о версии (SPEC §3). Клиент узнаёт её из
 * метаданных, ответов чтения страниц и результатов команд. Для каждой подтверждённой нами команды
 * запоминаются затронутые страницы, что позволяет корректно судить об актуальности снимка страницы:
 *
 *  - снимок страницы P с ревизией r «требуемо актуален», если r ≥ max ревизии наших команд, затронувших P;
 *  - если r < известной ревизии документа, но все ревизии в (r, revision] — наши команды, не трогавшие P,
 *    снимок эквивалентен снимку на ревизии revision (его можно «поднять» без перечитывания);
 *  - иначе снимок нужно перечитать (ответ старого чтения не должен восстанавливать устаревший цвет).
 */
export class DocState {
  private revisionValue = 0;
  private known = false;
  /** ревизия → страницы, затронутые нашей командой, давшей эту ревизию */
  private readonly affectedByRevision = new Map<number, ReadonlySet<string>>();

  get revision(): number | null {
    return this.known ? this.revisionValue : null;
  }

  reset(): void {
    this.revisionValue = 0;
    this.known = false;
    this.affectedByRevision.clear();
  }

  /** Ревизия, увиденная в метаданных или в ответе чтения страницы. */
  noteRevision(r: number): void {
    if (!this.known || r > this.revisionValue) this.revisionValue = r;
    this.known = true;
  }

  /** Подтверждённая сервером команда. */
  noteCommand(result: CommandResult): void {
    this.affectedByRevision.set(result.revision, new Set(result.affectedPages));
    this.noteRevision(result.revision);
    // не даём таблице расти бесконечно: хватает последних 10 000 ревизий
    if (this.affectedByRevision.size > 10_000) {
      const first = this.affectedByRevision.keys().next().value;
      if (first !== undefined) this.affectedByRevision.delete(first);
    }
  }

  /** Минимальная ревизия, при которой снимок страницы содержит все наши подтверждённые команды. */
  requiredRevision(pageId: string): number {
    let req = 0;
    for (const [rev, pages] of this.affectedByRevision) {
      if (rev > req && pages.has(pageId)) req = rev;
    }
    return req;
  }

  /**
   * Эффективная ревизия снимка страницы `pageId`, прочитанного на ревизии `r`:
   * число — снимок годится (возможно, «поднят» до текущей ревизии документа); null — нужно перечитать.
   */
  effectiveRevision(pageId: string, r: number): number | null {
    if (r < this.requiredRevision(pageId)) return null;
    if (!this.known || r >= this.revisionValue) return r;
    for (let x = r + 1; x <= this.revisionValue; x += 1) {
      const pages = this.affectedByRevision.get(x);
      if (!pages || pages.has(pageId)) return null;
    }
    return this.revisionValue;
  }
}
