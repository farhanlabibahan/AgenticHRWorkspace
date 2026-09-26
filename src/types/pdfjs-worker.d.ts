// pdfjs-dist ships no types for its worker module; src/server/ocr/pages.ts
// imports it only to hand pdf.js its in-thread "fake worker".
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
