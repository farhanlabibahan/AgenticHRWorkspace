// Stands in for extract.worker.ts in host.test.ts: vitest can't start a
// TypeScript worker. The document bytes are a command, so a test can make
// the worker hang, blow its heap, grow RSS, exit or throw.
import { parentPort } from 'node:worker_threads';

const held = [];

parentPort.on('message', ({ id, data }) => {
  const command = new TextDecoder().decode(data);
  switch (command) {
    case 'hang':
      for (;;);
    case 'heap': {
      const junk = [];
      for (;;) junk.push({ n: junk.length, s: `${junk.length}`.repeat(8) });
    }
    case 'rss': {
      // 16 MB every 5 ms, filled so the pages are really resident; stops at 512 MB.
      const grow = () => {
        held.push(Buffer.alloc(16 * 1024 * 1024, 1));
        if (held.length < 32) setTimeout(grow, 5);
      };
      grow();
      return;
    }
    case 'exit':
      process.exit(3);
    case 'throw':
      setTimeout(() => {
        throw new Error('stub worker blew up');
      });
      return;
    case 'encrypted':
      parentPort.postMessage({ id, ok: false, name: 'EncryptedDocumentError', message: 'The document is password-protected' });
      return;
    default:
      parentPort.postMessage({ id, ok: true, text: command, links: [], pages: 1 });
  }
});
