/** Fields of a persisted settings object, each still `unknown` until its own parser checks it; non-objects read as `{}`. */
export const fieldsOf = <T>(value: unknown) => (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof T, unknown>>;
