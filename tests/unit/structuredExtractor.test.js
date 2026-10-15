import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText,
  truncate,
  EXTRACTION_TYPES,
  ALL_EXTRACTION_TYPES,
  StructuredExtractionError,
  extractStructuredDataSnapshot,
  extractStructuredDataFromHtml,
  extractStructuredData
} from '../../src/browser/structuredExtractor.js';
import { BrowserManager } from '../../src/browser/browserManager.js';

describe('Structured Extractor Unit Tests (Brick 38)', () => {
  describe('Helpers (cleanText & truncate)', () => {
    test('cleanText collapses whitespace while preserving linebreaks and Unicode', () => {
      assert.equal(cleanText('   Hello \t\t World!   '), 'Hello World!');
      assert.equal(cleanText('Line 1\n\n\n\nLine 2'), 'Line 1\n\nLine 2');
      assert.equal(cleanText('  مرحبا    بالعالم  '), 'مرحبا بالعالم');
      assert.equal(cleanText(null), '');
      assert.equal(cleanText(123), '');
    });

    test('truncate caps string to maximum length', () => {
      assert.equal(truncate('123456789', 5), '12345');
      assert.equal(truncate('hello', 10), 'hello');
      assert.equal(truncate(null, 5), '');
    });
  });

  describe('Section 44: Page Metadata Extraction', () => {
    test('extracts title, URL, language, canonical URL, and description', () => {
      const html = `<!DOCTYPE html>
<html lang="en-US">
<head>
  <title>Test Page Title</title>
  <link rel="canonical" href="https://example.com/canonical-page" />
  <meta name="description" content="This is a test description." />
</head>
<body><h1>Main Header</h1></body>
</html>`;
      const res = extractStructuredDataFromHtml(html, {
        types: ['metadata'],
        pageUrl: 'https://example.com/canonical-page'
      });
      assert.equal(res.success, true);
      assert.ok(res.data.metadata);
      assert.equal(res.data.metadata.title, 'Test Page Title');
      assert.equal(res.data.metadata.language, 'en-US');
      assert.equal(res.data.metadata.canonicalUrl, 'https://example.com/canonical-page');
      assert.equal(res.data.metadata.description, 'This is a test description.');
    });

    test('handles missing metadata safely with nulls', () => {
      const html = `<html><body><p>Bare page</p></body></html>`;
      const res = extractStructuredDataFromHtml(html, { types: ['metadata'] });
      assert.ok(res.data.metadata);
      assert.equal(res.data.metadata.title, '');
      assert.equal(res.data.metadata.language, null);
      assert.equal(res.data.metadata.canonicalUrl, null);
      assert.equal(res.data.metadata.description, null);
    });

    test('preserves Unicode and Arabic in metadata', () => {
      const html = `<!DOCTYPE html>
<html lang="ar">
<head>
  <title>تقرير النظام الموحد</title>
  <meta name="description" content="وصف تفصيلي باللغة العربية" />
</head>
<body><h1>مرحبا</h1></body>
</html>`;
      const res = extractStructuredDataFromHtml(html, { types: ['metadata'] });
      assert.equal(res.data.metadata.title, 'تقرير النظام الموحد');
      assert.equal(res.data.metadata.language, 'ar');
      assert.equal(res.data.metadata.description, 'وصف تفصيلي باللغة العربية');
    });
  });

  describe('Section 45: Headings Extraction', () => {
    test('extracts h1-h6 in DOM order with correct levels', () => {
      const html = `
<div>
  <h1>Main Title</h1>
  <p>Intro</p>
  <h2>Section 1</h2>
  <h3>Subsection 1.1</h3>
  <h4>Detail A</h4>
  <h5>Subdetail i</h5>
  <h6>Footnote *</h6>
</div>`;
      const res = extractStructuredDataFromHtml(html, { types: ['headings'] });
      assert.equal(res.data.headings.length, 6);
      assert.deepEqual(res.data.headings.map(h => h.level), [1, 2, 3, 4, 5, 6]);
      assert.equal(res.data.headings[0].text, 'Main Title');
      assert.equal(res.data.headings[5].text, 'Footnote *');
    });

    test('includes empty headings with empty string', () => {
      const html = `<h1></h1><h2>   </h2>`;
      const res = extractStructuredDataFromHtml(html, { types: ['headings'] });
      assert.equal(res.data.headings.length, 2);
      assert.equal(res.data.headings[0].text, '');
      assert.equal(res.data.headings[1].text, '');
    });

    test('excludes hidden headings (display:none and hidden attribute)', () => {
      const html = `
<h1>Visible Heading</h1>
<h2 style="display:none;">Hidden By Style</h2>
<h3 hidden>Hidden By Attribute</h3>
<div style="visibility:hidden;"><h4>Hidden Parent</h4></div>
<h2 aria-hidden="true">Aria Hidden</h2>
`;
      const res = extractStructuredDataFromHtml(html, { types: ['headings'] });
      assert.equal(res.data.headings.length, 1);
      assert.equal(res.data.headings[0].text, 'Visible Heading');
    });

    test('preserves Unicode Arabic headings faithfully', () => {
      const html = `<h1>لوحة التحكم الرئيسية</h1><h2>الإحصائيات الشهرية</h2>`;
      const res = extractStructuredDataFromHtml(html, { types: ['headings'] });
      assert.equal(res.data.headings.length, 2);
      assert.equal(res.data.headings[0].text, 'لوحة التحكم الرئيسية');
      assert.equal(res.data.headings[1].text, 'الإحصائيات الشهرية');
    });
  });

  describe('Section 46: Links Extraction', () => {
    test('extracts absolute and relative links with same-origin detection', () => {
      const html = `
<div>
  <a href="/internal/docs">Internal Docs</a>
  <a href="https://external.org/guide" aria-label="External Guide">External Guide</a>
  <a href="#section-top">Anchor Link</a>
</div>`;
      const res = extractStructuredDataFromHtml(html, {
        types: ['links'],
        pageUrl: 'http://127.0.0.1:8080/index.html'
      });
      assert.equal(res.data.links.length, 3);
      assert.equal(res.data.links[0].text, 'Internal Docs');
      assert.equal(res.data.links[0].href, 'http://127.0.0.1:8080/internal/docs');
      assert.equal(res.data.links[0].sameOrigin, true);

      assert.equal(res.data.links[1].accessibleName, 'External Guide');
      assert.equal(res.data.links[1].href, 'https://external.org/guide');
      assert.equal(res.data.links[1].sameOrigin, false);
    });

    test('ignores hidden links and elements without href', () => {
      const html = `
<a href="/visible">Visible</a>
<a href="/hidden" style="display:none;">Hidden</a>
<a>No Href Link</a>
`;
      const res = extractStructuredDataFromHtml(html, { types: ['links'] });
      assert.equal(res.data.links.length, 1);
      assert.equal(res.data.links[0].text, 'Visible');
    });
  });

  describe('Section 47: Tables Extraction', () => {
    test('extracts table with caption, thead headers, and tbody rows', () => {
      const html = `
<table>
  <caption>Team Directory</caption>
  <thead>
    <tr><th>Name</th><th>Role</th><th>Status</th></tr>
  </thead>
  <tbody>
    <tr><td>Ahmed</td><td>Engineer</td><td>Active</td></tr>
    <tr><td>Sara</td><td>Designer</td><td>Active</td></tr>
  </tbody>
</table>`;
      const res = extractStructuredDataFromHtml(html, { types: ['tables'] });
      assert.equal(res.data.tables.length, 1);
      const table = res.data.tables[0];
      assert.equal(table.caption, 'Team Directory');
      assert.deepEqual(table.headers, ['Name', 'Role', 'Status']);
      assert.equal(table.rows.length, 2);
      assert.deepEqual(table.rows[0], ['Ahmed', 'Engineer', 'Active']);
      assert.deepEqual(table.rows[1], ['Sara', 'Designer', 'Active']);
      assert.equal(table.irregular, false);
    });

    test('detects irregular tables with colspans and uneven columns', () => {
      const html = `
<table>
  <caption>Irregular Financials</caption>
  <tr><th colspan="2">Consolidated</th><th>Q1</th></tr>
  <tr><td>Revenue</td><td>$100,000</td></tr>
</table>`;
      const res = extractStructuredDataFromHtml(html, { types: ['tables'] });
      assert.equal(res.data.tables.length, 1);
      const table = res.data.tables[0];
      assert.equal(table.irregular, true);
      assert.equal(table.rows.length, 1);
      assert.deepEqual(table.rows[0], ['Revenue', '$100,000']);
    });

    test('handles multiple tables independently', () => {
      const html = `
<table id="t1"><tr><th>Col A</th></tr><tr><td>Val 1</td></tr></table>
<table id="t2"><tr><th>Col B</th></tr><tr><td>Val 2</td></tr></table>
`;
      const res = extractStructuredDataFromHtml(html, { types: ['tables'] });
      assert.equal(res.data.tables.length, 2);
      assert.deepEqual(res.data.tables[0].headers, ['Col A']);
      assert.deepEqual(res.data.tables[1].headers, ['Col B']);
    });
  });

  describe('Section 48: Lists Extraction', () => {
    test('extracts ordered and unordered lists with nested sublists', () => {
      const html = `
<ul id="main-list">
  <li>Item 1</li>
  <li>Item 2
    <ul>
      <li>Subitem 2.1</li>
      <li>Subitem 2.2</li>
    </ul>
  </li>
  <li>Item 3</li>
</ul>`;
      const res = extractStructuredDataFromHtml(html, { types: ['lists'] });
      assert.equal(res.data.lists.length, 1);
      const list = res.data.lists[0];
      assert.equal(list.ordered, false);
      assert.equal(list.items.length, 3);
      assert.equal(list.items[0], 'Item 1');
      assert.ok(typeof list.items[1] === 'object');
      assert.equal(list.items[1].text, 'Item 2');
      assert.ok(list.items[1].nested);
      assert.deepEqual(list.items[1].nested.items, ['Subitem 2.1', 'Subitem 2.2']);
      assert.equal(list.items[2], 'Item 3');
    });

    test('extracts ARIA role="list" and role="listitem"', () => {
      const html = `
<div role="list">
  <div role="listitem">Objective 1</div>
  <div role="listitem">Objective 2</div>
</div>`;
      const res = extractStructuredDataFromHtml(html, { types: ['lists'] });
      assert.equal(res.data.lists.length, 1);
      assert.deepEqual(res.data.lists[0].items, ['Objective 1', 'Objective 2']);
    });

    test('respects maxNestingDepth limit', () => {
      const html = `
<ul>
  <li>L1
    <ul>
      <li>L2
        <ul>
          <li>L3</li>
        </ul>
      </li>
    </ul>
  </li>
</ul>`;
      const res = extractStructuredDataFromHtml(html, {
        types: ['lists'],
        limits: { maxNestingDepth: 2 }
      });
      assert.equal(res.data.lists.length, 1);
      const l1 = res.data.lists[0].items[0];
      assert.ok(l1.nested);
      const l2 = l1.nested.items[0];
      // At depth 2, deeper nested list is flattened or omitted
      assert.equal(typeof l2, 'string');
    });
  });

  describe('Section 49: Definitions Extraction', () => {
    test('extracts dl, dt, and dd into key-value pairs', () => {
      const html = `
<dl>
  <dt>Name</dt>
  <dd>JARVIS</dd>
  <dt>Architecture</dt>
  <dd>Modular</dd>
  <dd>Brick-by-Brick</dd>
</dl>`;
      const res = extractStructuredDataFromHtml(html, { types: ['definitions'] });
      assert.equal(res.data.definitions.length, 3);
      assert.deepEqual(res.data.definitions[0], { key: 'Name', value: 'JARVIS' });
      assert.deepEqual(res.data.definitions[1], { key: 'Architecture', value: 'Modular' });
      assert.deepEqual(res.data.definitions[2], { key: 'Architecture', value: 'Brick-by-Brick' });
    });
  });

  describe('Section 50: Repeated Semantic Records', () => {
    test('extracts repeated article records with headings, text, links, and fields', () => {
      const html = `
<article>
  <h2>Update 1</h2>
  <p>Paragraph 1 text.</p>
  <a href="/link1">Read More</a>
  <dl><dt>Version</dt><dd>1.0</dd></dl>
</article>
<article>
  <h2>Update 2</h2>
  <p>Paragraph 2 text.</p>
  <a href="/link2">Documentation</a>
</article>`;
      const res = extractStructuredDataFromHtml(html, { types: ['records'] });
      assert.equal(res.data.records.length, 2);
      assert.equal(res.data.records[0].heading, 'Update 1');
      assert.equal(res.data.records[0].text, 'Paragraph 1 text.');
      assert.equal(res.data.records[0].links.length, 1);
      assert.equal(res.data.records[0].fields.length, 1);
      assert.deepEqual(res.data.records[0].fields[0], { key: 'Version', value: '1.0' });

      assert.equal(res.data.records[1].heading, 'Update 2');
      assert.equal(res.data.records[1].fields.length, 0);
    });
  });

  describe('Section 51: Privacy Exclusions', () => {
    test('never extracts password, text, textarea, or hidden input values', () => {
      const html = `
<div>
  <h1>User Profile</h1>
  <form>
    <input type="password" value="SuperSecretPassword999!" />
    <input type="text" value="UserConfidentialText" />
    <textarea>SensitiveTextareaContent</textarea>
    <input type="hidden" value="secret_csrf_token_xyz" />
  </form>
</div>`;
      const res = extractStructuredDataFromHtml(html);
      const json = JSON.stringify(res.data);
      assert.equal(json.includes('SuperSecretPassword999!'), false);
      assert.equal(json.includes('UserConfidentialText'), false);
      assert.equal(json.includes('SensitiveTextareaContent'), false);
      assert.equal(json.includes('secret_csrf_token_xyz'), false);
    });
  });

  describe('Section 52 & 53: Limits, Truncation & Staleness', () => {
    test('truncates when maxRecords limit is reached and sets truncation metadata', () => {
      const html = `
<h1>H1</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4><h5>H5</h5><h6>H6</h6>
<p>Some text</p>
`;
      const res = extractStructuredDataFromHtml(html, {
        types: ['headings'],
        limits: { maxRecords: 3 }
      });
      assert.equal(res.data.headings.length, 3);
      assert.equal(res.truncated, true);
      assert.equal(res.truncationReason, 'MAX_RECORDS');
    });

    test('truncates when maxTextChars limit is reached', () => {
      const html = `
<h1>First Long Heading Text</h1>
<h2>Second Long Heading Text</h2>
`;
      const res = extractStructuredDataFromHtml(html, {
        types: ['headings'],
        limits: { maxTextChars: 25 }
      });
      assert.equal(res.truncated, true);
      assert.equal(res.truncationReason, 'MAX_TEXT_CHARS');
    });

    test('truncates long individual field text according to maxFieldChars', () => {
      const longTitle = 'A'.repeat(500);
      const html = `<title>${longTitle}</title>`;
      const res = extractStructuredDataFromHtml(html, {
        types: ['metadata'],
        limits: { maxFieldChars: 50 }
      });
      assert.equal(res.data.metadata.title.length, 50);
    });
  });

  describe('BrowserManager Integration Unit Tests', () => {
    test('extractStructuredData throws BROWSER_NOT_RUNNING if browser stopped', async () => {
      const bm = new BrowserManager();
      let threw = null;
      try {
        await bm.extractStructuredData({ expectedSnapshotToken: 'snap_test' });
      } catch (err) {
        threw = err;
      }
      assert.ok(threw);
      assert.equal(threw.code, 'BROWSER_NOT_RUNNING');
    });

    test('extractStructuredData requires expectedSnapshotToken', async () => {
      const bm = new BrowserManager();
      bm._state = 'running';
      bm.isSessionActive = () => true;
      bm._pages.set('pg_mock', {
        pageId: 'pg_mock',
        page: { isClosed: () => false },
        snapshotToken: 'snap_valid_123'
      });
      bm._activePageId = 'pg_mock';

      let threw = null;
      try {
        await bm.extractStructuredData({});
      } catch (err) {
        threw = err;
      }
      assert.ok(threw);
      assert.equal(threw.code, 'TARGET_STALE');
    });

    test('extractStructuredData rejects stale snapshot token with TARGET_STALE', async () => {
      const bm = new BrowserManager();
      bm._state = 'running';
      bm.isSessionActive = () => true;
      bm._pages.set('pg_mock', {
        pageId: 'pg_mock',
        page: { isClosed: () => false },
        snapshotToken: 'snap_valid_123'
      });
      bm._activePageId = 'pg_mock';
      bm.isSnapshotTokenValid = () => false;

      let threw = null;
      try {
        await bm.extractStructuredData({ expectedSnapshotToken: 'snap_stale_xyz' });
      } catch (err) {
        threw = err;
      }
      assert.ok(threw);
      assert.equal(threw.code, 'TARGET_STALE');
    });
  });
});
