export function required<T>(value: T | null | undefined): NonNullable<T> {
  if (value === null || value === undefined) throw new Error("Expected a value in the test fixture.");
  return value;
}
