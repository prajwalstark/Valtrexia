import { inspect } from "node:util";

const REDACTED = "[redacted]";

/**
 * Holds a sensitive value so it cannot be printed by accident. Logging it,
 * serializing it to JSON, interpolating it into a string or inspecting it in
 * a debugger all yield "[redacted]". The value comes out only through an
 * explicit `expose()` call, which makes every use easy to find in review.
 */
export class Secret<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /** Returns the wrapped value. Do not log or return what this gives you. */
  expose(): T {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
