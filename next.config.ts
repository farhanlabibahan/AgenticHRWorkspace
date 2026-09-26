import type { NextConfig } from 'next';

// src/server/text/pdf.ts finds these through pdfjs-dist's package.json.
const PDFJS_DATA = [
  'node_modules/pdfjs-dist/package.json',
  'node_modules/pdfjs-dist/cmaps/**',
  'node_modules/pdfjs-dist/standard_fonts/**',
];

// OCR for scanned resumes (src/server/ocr), about 42 MB, shipped with its own
// cron only: never the careers page or the apply action. tesseract.js starts
// its worker thread from a path, so tracing finds that entry but nothing it
// requires (an isolated build failed with "Cannot find module
// 'tesseract.js-core/tesseract-core-relaxedsimd'"). tesseract.js 7.0.0 in
// Node always loads the full core, not the LSTM-only one: whichever of plain,
// SIMD and relaxed-SIMD the CPU supports. pdfjs-dist's own build (not
// unpdf's) decodes CCITT, JBIG2 and JPEG 2000 page images with its wasm/
// decoders. One language pack per OCR_LANGS code (read here at build time;
// src/server/ocr/engine.ts parses it the same way at run time). Turbopack
// also traces each core's .wasm.js twin (the WebAssembly inlined for
// browsers, 14 MB in all) from the core's own code, and ignores
// outputFileTracingExcludes for them; Node only reads the .wasm files.
const OCR_LANGS = (() => {
  const langs = (process.env.OCR_LANGS ?? '').split(/[+,\s]+/).filter(Boolean);
  return langs.length && langs.every((l) => /^[a-z]{3}(?:_[a-z]+)?$/i.test(l)) ? langs : ['eng'];
})();
const OCR_FILES = [
  ...OCR_LANGS.flatMap((lang) => [
    `node_modules/@tesseract.js-data/${lang}/package.json`,
    `node_modules/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,
  ]),
  'node_modules/tesseract.js/package.json',
  'node_modules/tesseract.js/src/**/*.js',
  'node_modules/tesseract.js-core/package.json',
  'node_modules/tesseract.js-core/tesseract-core{,-simd,-relaxedsimd}.{js,wasm}',
  'node_modules/{bmp-js,is-url,regenerator-runtime,wasm-feature-detect}/**',
  'node_modules/pdfjs-dist/legacy/build/pdf{,.worker}.mjs',
  'node_modules/pdfjs-dist/wasm/{jbig2,openjpeg,qcms_bg}.wasm',
];

// The marketing site (homepage, /agencies, /self-hosted, /talent-network, and
// /extension, which redirects there) is its own app in a
// private repo, served at this same address: Next.js multi-zones. These
// rewrites hand it those paths and its assets (it builds with assetPrefix
// '/site-assets'). They run before this app's own pages, so its `/` wins over
// app/page.tsx. Without MARKETING_ORIGIN (a self-hosted install), `/` is the
// sign-in page and the marketing paths don't exist. Links between the zones
// are plain <a>s: a client-side navigation can't cross into the other app.
const MARKETING_ORIGIN = process.env.MARKETING_ORIGIN?.replace(/\/+$/, '');
const MARKETING_PATHS = ['/', '/agencies', '/self-hosted', '/talent-network', '/extension', '/site-assets/:path*'];

const nextConfig: NextConfig = {
  // Keep the Docker self-host path honest (see docs/03-architecture.md).
  output: process.env.DOCKER_BUILD ? 'standalone' : undefined,
  // Dev only: let `next dev` serve its chunks to LAN devices (phone, other
  // machines). Without this, Next blocks non-localhost origins and every
  // page sits on its skeleton because client data loaders never run.
  allowedDevOrigins: ['192.168.*.*', '*.local'],
  experimental: {
    serverActions: { bodySizeLimit: '8mb' }, // resume uploads
    staleTimes: { dynamic: 60, static: 180 },
    // Next 16.3 keeps Turbopack's cache across production builds, and Vercel
    // restores it on every deploy. It served a stale compile of globals.css:
    // a new @utility (is-focused, PR #86) never reached the live stylesheet
    // even though the classes using it did. Always compile builds fresh.
    turbopackFileSystemCacheForBuild: false,
  },
  // Node-only resume text extractors (src/server/text): load them from
  // node_modules as published rather than bundling them. unpdf imports its
  // 1.7 MB serverless pdf.js build at runtime (import('unpdf/pdfjs')).
  serverExternalPackages: ['unpdf', 'word-extractor', 'tesseract.js', 'pdfjs-dist'],
  // pdf.js reads CJK character maps and the standard fonts from disk by path
  // at runtime, which file tracing can't see. Ship them with every route that
  // extracts text: careers apply, import slices and the crons.
  outputFileTracingIncludes: {
    ...Object.fromEntries(['/careers/**', '/api/imports/**', '/api/cron/**'].map((route) => [route, PDFJS_DATA])),
    '/api/cron/ocr': OCR_FILES,
  },
  async rewrites() {
    if (!MARKETING_ORIGIN) return [];
    return {
      beforeFiles: MARKETING_PATHS.map((source) => ({ source, destination: `${MARKETING_ORIGIN}${source}` })),
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
