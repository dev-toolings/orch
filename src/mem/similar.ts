// similar: find active notes that another note likely restates or changes,
// for `orch mem review`. Deterministic, no model. It never removes anything:
// a pair only asks the lead to decide.
//
// A note is split into values (numbers, identifiers such as bivouac-7 or
// atlas_qa_ember) and subject words. Similarity is an IDF-weighted Jaccard of
// subject words, where a shared value counts as a strong shared term and a
// differing value counts for nothing: a changed value is exactly what an
// update looks like, so it must not push the two notes apart.

const STOP = new Set(`
a afin ai au aux avec c ca ce ces cet cette d dans de des du elle elles en est et etre eux il ils je l la le les leur
leurs lui m ma mais me meme mes mon n ne nos notre nous on ou par pas pour qu que qui s sa sans se ses si son sont sur
ta te tes ton tu un une vos votre vous y ont fait faire doit doivent peut peuvent tout tous toute toutes tres
jamais plus moins uniquement seulement que quand comme aussi encore deja
an and are as at be been but by for from has have i in into is it its no not of on or our so than that the their them
then there these they this to was we were what when which who will with you your must should can only never always
desormais maintenant dorenavant finalement passe passent devient deviennent change changes changement correction now
anymore longer instead becomes become changed
`.split(/\s+/).filter(Boolean));

const VALUE = /[\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)+|[\p{L}]*\p{N}[\p{L}\p{N}]*/gu;

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const stem = (w: string) => (w.length > 4 && /[sx]$/.test(w) ? w.slice(0, -1) : w);

export interface Terms { words: Set<string>; values: Set<string> }

export function terms(text: string): Terms {
  const folded = fold(text);
  const values = new Set(folded.match(VALUE) ?? []);
  const words = new Set(
    folded.replace(VALUE, " ").split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !STOP.has(w))
      .map(stem),
  );
  return { words, values };
}

export interface Match<T> { item: T; score: number }

// Score `body` against each candidate text; return those at or above the
// threshold, best first. IDF is computed over the candidates plus the body.
export function similar<T>(body: string, items: T[], text: (item: T) => string, threshold = SIMILAR_THRESHOLD): Match<T>[] {
  const mine = terms(body);
  const theirs = items.map((item) => ({ item, t: terms(text(item)) }));
  const df = new Map<string, number>();
  for (const t of [mine, ...theirs.map((x) => x.t)]) {
    for (const k of new Set([...t.words, ...[...t.values].map((v) => `#${v}`)])) df.set(k, (df.get(k) ?? 0) + 1);
  }
  const n = theirs.length + 1;
  const idf = (k: string) => Math.log(1 + n / (df.get(k) ?? 1));
  const out: Match<T>[] = [];
  for (const { item, t } of theirs) {
    let shared = 0;
    let union = 0;
    for (const w of new Set([...mine.words, ...t.words])) {
      const weight = idf(w);
      union += weight;
      if (mine.words.has(w) && t.words.has(w)) shared += weight;
    }
    for (const v of mine.values) {
      if (!t.values.has(v)) continue;
      const weight = idf(`#${v}`);
      shared += weight;
      union += weight;
    }
    const score = union ? shared / union : 0;
    if (score >= threshold) out.push({ item, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

// Measured 2026-10-21. On 101 real adds over 12 stores, 0.2 flags 17: 14 real
// supersedes, 2 replacements done as forget then add, 1 complement on the
// same feature. It finds 14 of the 17 real supersedes (misses: a note
// rewritten in another language, two long status rewrites). On the synthetic
// corpus (tests/fixtures/mem-dedup) it also flags most same-subject different
// facts: the lead judges, nothing is automatic.
export const SIMILAR_THRESHOLD = 0.2;
