export interface IdGenerator {
  /** Time-ordered UUID (v7): also used as a stable ledger cursor. */
  next(): string;
}
export const ID_GENERATOR = Symbol('IdGenerator');

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
