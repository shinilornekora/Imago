/** In-memory реализация DomainTx для модульных тестов предметного модуля. */
import type { Shape } from '@stand/shared';
import type { DocumentRevision, DomainTx, ShapeOwner, SourceUpdateResult, StoredOperation } from '../src/domain/index.js';

export interface FakeDoc {
  id: string;
  ownerId: string;
  revision: number;
}

export class FakeTx implements DomainTx {
  docs = new Map<string, FakeDoc>();
  shapes = new Map<string, Shape>();
  ops = new Map<string, StoredOperation>();
  calls: string[] = [];

  addDoc(id: string, ownerId: string, revision = 0): void {
    this.docs.set(id, { id, ownerId, revision });
  }

  addShape(partial: Partial<Shape> & { id: string; documentId: string; pageId: string }): Shape {
    const s: Shape = {
      kind: 'rect', x: 0, y: 0, w: 10, h: 10, z: 0, text: null, fill: '#000000',
      isSource: false, sourceId: null, fillOverridden: false, ...partial,
    };
    this.shapes.set(s.id, s);
    return s;
  }

  async readRevision(docId: string): Promise<DocumentRevision | null> {
    this.calls.push(`readRevision:${docId}`);
    const d = this.docs.get(docId);
    return d ? { ownerId: d.ownerId, revision: d.revision } : null;
  }

  async readShapeOwner(shapeId: string): Promise<ShapeOwner | null> {
    this.calls.push(`readShapeOwner:${shapeId}`);
    const s = this.shapes.get(shapeId);
    if (!s) return null;
    const d = this.docs.get(s.documentId);
    if (!d) return null;
    return { documentId: s.documentId, ownerId: d.ownerId, pageId: s.pageId, isSource: s.isSource, sourceId: s.sourceId };
  }

  async updateSourceAndInstances(sourceId: string, fill: string): Promise<SourceUpdateResult> {
    this.calls.push(`updateSourceAndInstances:${sourceId}:${fill}`);
    const pages = new Set<string>();
    let n = 0;
    for (const s of this.shapes.values()) {
      if ((s.id === sourceId && s.isSource) || (s.sourceId === sourceId && !s.fillOverridden)) {
        s.fill = fill;
        pages.add(s.pageId);
        n++;
      }
    }
    return { affectedPages: [...pages].sort(), affectedShapes: n };
  }

  async updateShapeFill(shapeId: string, fill: string): Promise<{ pageId: string }> {
    this.calls.push(`updateShapeFill:${shapeId}:${fill}`);
    const s = this.shapes.get(shapeId);
    if (!s) throw new Error('missing shape');
    s.fill = fill;
    s.fillOverridden = true;
    return { pageId: s.pageId };
  }

  async bumpRevision(docId: string): Promise<number> {
    this.calls.push(`bumpRevision:${docId}`);
    const d = this.docs.get(docId);
    if (!d) throw new Error('missing doc');
    d.revision += 1;
    return d.revision;
  }

  async readOperation(opId: string): Promise<StoredOperation | null> {
    this.calls.push(`readOperation:${opId}`);
    return this.ops.get(opId) ?? null;
  }

  async writeOperation(op: StoredOperation): Promise<void> {
    this.calls.push(`writeOperation:${op.opId}`);
    this.ops.set(op.opId, structuredClone(op));
  }
}
