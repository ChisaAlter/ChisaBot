let nextObjectKey = 0;
const objectKeys = new WeakMap<object, number>();

/** Returns a stable primitive key for an object reference for useExternalConnection. */
export function objectConnectionKey(
  value: object | null | undefined,
): number | false {
  if (!value) return false;
  let key = objectKeys.get(value);
  if (key === undefined) {
    nextObjectKey += 1;
    key = nextObjectKey;
    objectKeys.set(value, key);
  }
  return key;
}
