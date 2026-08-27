/** Levenshtein edit distance and did-you-mean suggestions. */

export function levenshtein(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  let previous: number[] = [];
  for (let j = 0; j <= b.length; j += 1) {
    previous.push(j);
  }
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      const fromDeletion = (previous[j] ?? 0) + 1;
      const fromInsertion = (current[j - 1] ?? 0) + 1;
      const fromSubstitution = (previous[j - 1] ?? 0) + substitutionCost;
      current.push(Math.min(fromDeletion, fromInsertion, fromSubstitution));
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

/**
 * Return the closest candidate within the edit threshold, or null. Candidates
 * are scanned in order so registry order breaks ties deterministically.
 */
export function suggestName(
  candidates: readonly string[],
  input: string,
  maximumDistance = 2
): string | null {
  let best: string | null = null;
  let bestDistance = maximumDistance + 1;
  for (const candidate of candidates) {
    const distance = levenshtein(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
