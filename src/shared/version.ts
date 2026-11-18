/** Version of the Troqo package: client, worker and server ship together. Keep in sync with package.json. */
export const VERSION = "0.8.0";

/** Whether version `a` is older than `b` (numeric x.y.z; anything after a "-" is ignored). */
export function isOlder(a: string, b: string): boolean {
  const parts = (v: string) => v.split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}
