/**
 * Shared log-configuration state.
 *
 * Keeps the `useLocalTime` preference accessible to the server-log writer
 * (index.ts) without a circular dependency.  The settings route updates this
 * whenever the user saves a new value; index.ts reads it on every write.
 */

let _useLocalTime = false;

export function getLogUseLocalTime(): boolean {
  return _useLocalTime;
}

export function setLogUseLocalTime(value: boolean): void {
  _useLocalTime = value;
}
