// word-extractor 1.0.4 ships no types; this covers the part src/server/text/doc.ts uses.
declare module 'word-extractor' {
  /** filterUnicode (default true) turns smart quotes and dashes into ASCII. */
  type Options = { filterUnicode?: boolean };

  class Document {
    getBody(options?: Options): string;
    getFootnotes(options?: Options): string;
    getEndnotes(options?: Options): string;
    getHeaders(options?: Options & { includeFooters?: boolean }): string;
    getFooters(options?: Options): string;
    getAnnotations(options?: Options): string;
    getTextboxes(options?: Options & { includeHeadersAndFooters?: boolean; includeBody?: boolean }): string;
  }

  export default class WordExtractor {
    extract(source: string | Buffer): Promise<Document>;
  }
}
