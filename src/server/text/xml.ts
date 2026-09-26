/**
 * A small non-validating XML scanner for machine-written office XML (OOXML,
 * ODF). It is linear (indexOf/charCodeAt, no backtracking regex), tracks
 * nesting in arrays rather than recursion, and never expands DTD entities:
 * only the five predefined entities and numeric references are decoded, and a
 * DOCTYPE is skipped as an opaque token (no XXE, no billion laughs).
 */

type XmlHandlers = {
  open(name: string, attrs: string, selfClosing: boolean): void;
  close(name: string): void;
  text(text: string): void;
};

/** Handlers get qualified names and the raw attribute string; a self-closing tag produces open() then close(). */
function scanXml(xml: string, h: XmlHandlers): void {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      h.text(decodeEntities(xml.slice(i)));
      return;
    }
    if (lt > i) h.text(decodeEntities(xml.slice(i, lt)));
    const c = xml.charCodeAt(lt + 1);
    if (c === 33 /* ! */) {
      if (xml.startsWith('<!--', lt)) {
        const e = xml.indexOf('-->', lt + 4);
        i = e < 0 ? n : e + 3;
      } else if (xml.startsWith('<![CDATA[', lt)) {
        const e = xml.indexOf(']]>', lt + 9);
        h.text(xml.slice(lt + 9, e < 0 ? n : e));
        i = e < 0 ? n : e + 3;
      } else {
        // <!DOCTYPE …[ internal subset ]>: skipped, never interpreted.
        let j = lt + 2;
        for (let depth = 0; j < n; j++) {
          const d = xml.charCodeAt(j);
          if (d === 91) depth++;
          else if (d === 93) depth--;
          else if (d === 62 && depth <= 0) break;
        }
        i = j + 1;
      }
      continue;
    }
    if (c === 63 /* ? */) {
      const e = xml.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    // The closing '>' outside quoted attribute values.
    let j = lt + 1;
    for (let q = 0; j < n; j++) {
      const d = xml.charCodeAt(j);
      if (q) {
        if (d === q) q = 0;
      } else if (d === 34 || d === 39) q = d;
      else if (d === 62) break;
    }
    const closing = c === 47; /* / */
    const s0 = closing ? lt + 2 : lt + 1;
    let k = s0;
    while (k < j) {
      const d = xml.charCodeAt(k);
      if (d === 32 || d === 9 || d === 10 || d === 13 || d === 47 || d === 62) break;
      k++;
    }
    const name = xml.slice(s0, k);
    if (closing) h.close(name);
    else {
      const selfClosing = xml.charCodeAt(j - 1) === 47;
      h.open(name, xml.slice(k, selfClosing ? j - 1 : j), selfClosing);
      if (selfClosing) h.close(name);
    }
    i = j + 1;
  }
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (all, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
    }
    return NAMED[e] ?? all;
  });
}

type NsHandlers = {
  /** `name` is canonical ("w:t"); attr("w:val") resolves attribute prefixes through the declarations in scope. */
  open(name: string, attr: (qname: string) => string | null, selfClosing: boolean): void;
  close(name: string): void;
  text(text: string): void;
};

/**
 * scanXml plus namespace resolution: element names come out with canonical
 * prefixes chosen by namespace URI, so `<w:p>`, `<ns0:p>` and
 * `<p xmlns="…/main">` all arrive as "w:p". Declarations are scoped to their
 * element. Names in unknown namespaces get the "?" prefix.
 */
export function scanXmlNs(xml: string, canonical: Record<string, string>, h: NsHandlers): void {
  const scope = new Map<string, string>(); // declared prefix ('' = default) -> canonical prefix
  const undo: { depth: number; prefix: string; prev: string | undefined }[] = [];
  let depth = 0;
  const canonName = (q: string) => {
    const c = q.indexOf(':');
    const p = c < 0 ? '' : q.slice(0, c);
    const cp = scope.get(p);
    if (cp === undefined) return c < 0 ? q : '?' + q.slice(c);
    return cp + ':' + (c < 0 ? q : q.slice(c + 1));
  };
  const readAttr = (attrs: string, qname: string): string | null => {
    const c = qname.indexOf(':');
    const want = c < 0 ? '' : qname.slice(0, c);
    const local = c < 0 ? qname : qname.slice(c + 1);
    if (attrs.indexOf(local) < 0) return null;
    let found: string | null = null;
    eachAttr(attrs, (name, value) => {
      const k = name.indexOf(':');
      if ((k < 0 ? name : name.slice(k + 1)) !== local) return false;
      // Unprefixed attributes are accepted leniently (some writers omit the w: prefix).
      if (k >= 0 && scope.get(name.slice(0, k)) !== want && name.slice(0, k) !== want) return false;
      found = decodeEntities(value);
      return true;
    });
    return found;
  };
  scanXml(xml, {
    open(q, attrs, selfClosing) {
      depth++;
      if (attrs.indexOf('xmlns') >= 0) {
        eachAttr(attrs, (name, value) => {
          if (name !== 'xmlns' && !name.startsWith('xmlns:')) return false;
          const prefix = name.slice(6);
          undo.push({ depth, prefix, prev: scope.get(prefix) });
          scope.set(prefix, canonical[decodeEntities(value)] ?? '?');
          return false;
        });
      }
      h.open(canonName(q), (qn) => readAttr(attrs, qn), selfClosing);
    },
    close(q) {
      h.close(canonName(q));
      while (undo.length && undo[undo.length - 1].depth === depth) {
        const u = undo.pop()!;
        if (u.prev === undefined) scope.delete(u.prefix);
        else scope.set(u.prefix, u.prev);
      }
      depth--;
    },
    text: h.text,
  });
}

/**
 * Calls fn(name, rawValue) for each `name="value"` pair until it returns true.
 * Hand-rolled because a regex over attributes backtracks quadratically on a
 * long unterminated name.
 */
function eachAttr(attrs: string, fn: (name: string, value: string) => boolean): void {
  const n = attrs.length;
  const space = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
  let i = 0;
  while (i < n) {
    while (i < n && space(attrs.charCodeAt(i))) i++;
    const start = i;
    while (i < n && !space(attrs.charCodeAt(i)) && attrs.charCodeAt(i) !== 61 /* = */) i++;
    const name = attrs.slice(start, i);
    while (i < n && space(attrs.charCodeAt(i))) i++;
    if (attrs.charCodeAt(i) !== 61) continue;
    i++;
    while (i < n && space(attrs.charCodeAt(i))) i++;
    const q = attrs[i];
    if (q !== '"' && q !== "'") continue;
    const end = attrs.indexOf(q, i + 1);
    if (end < 0) return;
    if (fn(name, attrs.slice(i + 1, end))) return;
    i = end + 1;
  }
}

export type Rel = { type: string; target: string; external: boolean };

/** The relationships in a .rels part (whose attributes have no prefixes), by Id. */
export function parseRels(xml: string | null): Map<string, Rel> {
  const rels = new Map<string, Rel>();
  if (!xml) return rels;
  scanXml(xml, {
    open(name, attrs) {
      if (name !== 'Relationship' && !name.endsWith(':Relationship')) return;
      const a = new Map<string, string>();
      eachAttr(attrs, (k, v) => {
        a.set(k, decodeEntities(v));
        return false;
      });
      const id = a.get('Id');
      const target = a.get('Target');
      if (id && target != null) rels.set(id, { type: a.get('Type') ?? '', target, external: a.get('TargetMode') === 'External' });
    },
    close() {},
    text() {},
  });
  return rels;
}
