// Mirrors Commander's global-option handling without loading its command graph.
export function firstCommandIndex(values: readonly string[]): number {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--") return index + 1;
    if (value.startsWith("--")) {
      if (value === "--profile" || value === "--host") index += 1;
      continue;
    }
    if (value.length > 1 && value.startsWith("-")) {
      for (let char = 1; char < value.length; char += 1) {
        if (value[char] !== "p" && value[char] !== "H") continue;
        if (char === value.length - 1) index += 1;
        break;
      }
      continue;
    }
    return index;
  }
  return -1;
}
