// Community document search. Each community gets its own index, built once at startup from
// data/communities/<id>/docs/*.md, so a search can only ever see that community's documents.
//
// Documents are untrusted: anything that looks like an instruction to the assistant is replaced
// before indexing, so it can never reach the model as text it might follow.
// Documents are split into small chunks (CHUNK_CHARS) so even a document far larger than the
// model's context window only ever contributes a few short excerpts.
//
// Scoring is deliberately simple: the sum of idf weights of the query terms a chunk contains,
// with a boost for terms in the document title or section heading. Ties go to the shorter chunk.
import fs from 'node:fs';
import path from 'node:path';

export const REMOVED = '[removed: text addressed to the assistant]';
const INSTRUCTION_LINE = [
  /ASSISTANT\s+INSTRUCTION\s*:/i,
  /\bignore\s+(all\s+|any\s+)?(previous|prior|above)\s+instructions\b/i,
  /\b(system|assistant)\s+prompt\s*:/i,
];

const STOPWORDS = new Set(
  ('a an the is are was were be been being what when where who whom which why how do does did can could should would will ' +
    'our my we us i you your it its of for to in on at by with about from and or if this that these those there any me tell ' +
    'please have has had as so than then into not no yes all some much many more most get got know find show give').split(' '),
);

export function sanitize(text) {
  return text
    .split(/\r?\n/)
    .map((line) => (INSTRUCTION_LINE.some((re) => re.test(line)) ? REMOVED : line))
    .join('\n');
}

export function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/(\d),(?=\d{3})/g, '$1')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

const sentences = (text) => text.split(/(?<=[.!?])\s+/).filter(Boolean);

/** Split one section's paragraphs into chunks of at most `max` characters, on sentence boundaries. */
function chunkText(paragraphs, max) {
  const chunks = [];
  let current = '';
  const push = () => { if (current) chunks.push(current); current = ''; };
  for (const paragraph of paragraphs) {
    for (let sentence of sentences(paragraph)) {
      while (sentence.length > max) {
        // A single sentence longer than a chunk: cut it at the last space before the limit.
        push();
        const cut = sentence.lastIndexOf(' ', max) > 0 ? sentence.lastIndexOf(' ', max) : max;
        chunks.push(sentence.slice(0, cut));
        sentence = sentence.slice(cut).trim();
      }
      if (current && current.length + 1 + sentence.length > max) push();
      current = current ? `${current} ${sentence}` : sentence;
    }
    push();
  }
  return chunks;
}

/** Parse one markdown document into { title, chunks: [{ heading, text }] }. */
export function chunkDocument(markdown, { maxChars, fallbackTitle }) {
  const lines = sanitize(markdown).split('\n');
  let title = fallbackTitle;
  const sections = [{ heading: '', paragraphs: [], lines: [] }];
  for (const line of lines) {
    const heading = line.match(/^(#+)\s+(.*)$/);
    if (heading) {
      if (heading[1].length === 1 && title === fallbackTitle) title = heading[2].trim();
      else sections.push({ heading: heading[2].trim(), paragraphs: [], lines: [] });
      continue;
    }
    const section = sections[sections.length - 1];
    if (line.trim() === '') {
      if (section.lines.length) section.paragraphs.push(section.lines.join(' '));
      section.lines = [];
    } else {
      section.lines.push(line.trim());
    }
  }
  const chunks = [];
  for (const section of sections) {
    if (section.lines.length) section.paragraphs.push(section.lines.join(' '));
    for (const text of chunkText(section.paragraphs, maxChars)) chunks.push({ heading: section.heading, text });
  }
  return { title, chunks };
}

function buildCommunityIndex(docsDir, maxChars) {
  const files = docsDir && fs.existsSync(docsDir) ? fs.readdirSync(docsDir).filter((f) => f.endsWith('.md')).sort() : [];
  const chunks = [];
  for (const file of files) {
    const { title, chunks: parts } = chunkDocument(fs.readFileSync(path.join(docsDir, file), 'utf8'), { maxChars, fallbackTitle: file });
    for (const part of parts) {
      chunks.push({
        doc: file,
        title,
        excerpt: part.text,
        terms: new Set(tokenize(part.text.replaceAll(REMOVED, ''))),
        titleTerms: new Set(tokenize(`${title} ${part.heading}`)),
      });
    }
  }
  const df = new Map();
  for (const c of chunks) for (const t of new Set([...c.terms, ...c.titleTerms])) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log(1 + chunks.length / (df.get(t) || chunks.length));
  return { chunks, idf };
}

export function buildDocIndex(catalog, { chunkChars }) {
  const indexes = new Map(catalog.communityIds().map((cid) => [cid, buildCommunityIndex(catalog.docsDir(cid), chunkChars)]));

  return {
    /** All chunks for one community (used by tests to check sizes). */
    chunks: (cid) => indexes.get(cid)?.chunks ?? [],

    /** @returns {{doc, title, excerpt}[]} best matches first; empty when nothing matches */
    search(cid, query, { topK = 3 } = {}) {
      const index = indexes.get(cid);
      if (!index) return [];
      const terms = [...new Set(tokenize(query))];
      return index.chunks
        .map((c) => {
          let score = 0;
          for (const t of terms) {
            if (c.terms.has(t)) score += index.idf(t);
            if (c.titleTerms.has(t)) score += 0.5 * index.idf(t);
          }
          return { c, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || a.c.excerpt.length - b.c.excerpt.length)
        .slice(0, topK)
        .map(({ c }) => ({ doc: c.doc, title: c.title, excerpt: c.excerpt }));
    },
  };
}
