/** The name Courier was invoked as: `courier` or `tc courier`. Hints and usage text use it. */
let name = 'courier';

export function setProgramName(n: string): void {
  name = n;
}

export function programName(): string {
  return name;
}

/** A Courier command as the user should type it, e.g. `cmd('init --resume')`. */
export function cmd(rest: string): string {
  return `${name} ${rest}`;
}
