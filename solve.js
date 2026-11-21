// Fast drop-in for csv-reader 1.0.0, written in this session for make.fun
// "Read broken CSV files faster, 21 November 2026".
//
// Same answers as csv-reader 1.0.0 on every input, but faster: instead of
// reading one character at a time, each field is taken as a slice between
// delimiters found by the regex engine (one C++ scan per field), quoted
// fields are taken as slices between quotes found by indexOf, and line
// numbers are only counted where a line break can actually sit. No clock,
// no randomness, nothing kept from one call to the next.

const DELIM = /[,\n\r]/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Errors pushed while reading it use these.
  let recordLine = 1;
  let recordRow = null;

  // ended: 0 = comma, 1 = line break, 2 = end of text.

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the
  // field and how it ended; `added` counts the characters kept.
  function readUnquoted(value, added) {
    while (pos < n) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        if (pos < n) {
          value += text.slice(pos, n);
          added += n - pos;
        }
        pos = n;
        return { value, ended: 2, added };
      }
      const end = m.index;
      const ch = m[0];
      if (ch === ',') {
        if (end > pos) {
          value += text.slice(pos, end);
          added += end - pos;
        }
        pos = end + 1;
        return { value, ended: 0, added };
      }
      if (ch === '\n') {
        if (end > pos) {
          value += text.slice(pos, end);
          added += end - pos;
        }
        pos = end + 1;
        line += 1;
        return { value, ended: 1, added };
      }
      // ch === '\r'
      if (end + 1 < n && text.charCodeAt(end + 1) === 10) {
        if (end > pos) {
          value += text.slice(pos, end);
          added += end - pos;
        }
        pos = end + 2;
        line += 1;
        return { value, ended: 1, added };
      }
      // Lone CR: dropped, error recorded, reading goes on after it.
      if (end > pos) {
        value += text.slice(pos, end);
        added += end - pos;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = end + 1;
    }
    return { value, ended: 2, added };
  }

  // How many line breaks sit in text[a..b): every LF, plus every CR not
  // followed by LF (a CRLF counts once, through its LF). The slice keeps
  // every search inside the segment instead of running to the end of the
  // text when the segment holds no break at all.
  function countBreaks(a, b) {
    const seg = text.slice(a, b);
    let c = 0;
    let i = seg.indexOf('\n');
    while (i !== -1) {
      c += 1;
      i = seg.indexOf('\n', i + 1);
    }
    i = seg.indexOf('\r');
    while (i !== -1) {
      if (i + 1 >= seg.length || seg.charCodeAt(i + 1) !== 10) c += 1;
      i = seg.indexOf('\r', i + 1);
    }
    return c;
  }

  // A segment of a quoted field, text[a..b), with CRLF and lone CR inside
  // it each read as one LF.
  function convertSegment(a, b) {
    if (a === b) return '';
    const seg = text.slice(a, b);
    if (seg.indexOf('\r') === -1) return seg;
    return seg.replace(/\r\n?/g, '\n');
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let segStart = pos + 1;
    let parts = null;
    let value = '';
    let search = segStart;
    while (true) {
      const q = text.indexOf('"', search);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"', 0);
      }
      if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
        // Doubled quote: one quote in the value, reading goes on.
        line += countBreaks(segStart, q);
        if (parts === null) parts = [];
        parts.push(convertSegment(segStart, q));
        parts.push('"');
        search = q + 2;
        segStart = q + 2;
        continue;
      }
      // Closing quote.
      line += countBreaks(segStart, q);
      if (parts === null) {
        value = convertSegment(segStart, q);
      } else {
        parts.push(convertSegment(segStart, q));
        value = parts.join('');
      }
      pos = q + 1;
      break;
    }
    if (pos >= n) return { value, ended: 2 };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: 0 };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: 1 };
    }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: 1 };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value, 0);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('', 0);
      fields.push(field.value);
    } while (field.ended === 0);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
