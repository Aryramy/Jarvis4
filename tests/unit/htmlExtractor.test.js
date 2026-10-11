import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractHtmlContent, normalizeText } from '../../src/webpage/htmlExtractor.js';
import { PageReaderError } from '../../src/webpage/urlSafety.js';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const FIXTURES_DIR = resolve(__dirname, '../fixtures/html');

function readFixture(name) {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

test('HTML Text & Metadata Extraction - Unit Tests (Brick 21 Section 40)', async (t) => {
  await t.test('38. <title> extracted correctly with surrounding whitespace normalized', () => {
    const html = readFixture('article.html');
    const result = extractHtmlContent(html);
    assert.equal(result.title, 'The Future of Artificial Intelligence');
  });

  await t.test('38b. <title> is null if no title element exists', () => {
    const html = '<!DOCTYPE html><html><body><main><p>Content without title</p></main></body></html>';
    const result = extractHtmlContent(html);
    assert.equal(result.title, null);
  });

  await t.test('39. main text extracted when <main> exists', () => {
    const html = readFixture('article.html');
    const result = extractHtmlContent(html);
    assert.match(result.text, /Artificial Intelligence Horizons/);
    assert.match(result.text, /Modular architectures enable safe/);
    // Header and footer are excluded when main exists
    assert.doesNotMatch(result.text, /Header content/);
    assert.doesNotMatch(result.text, /Footer copyright/);
  });

  await t.test('40. article text extracted when <article> exists and no <main>', () => {
    const html = readFixture('noisy.html');
    const result = extractHtmlContent(html);
    assert.match(result.text, /Deep Learning Systems/);
    assert.match(result.text, /Clean text inside article container/);
  });

  await t.test('41. body fallback works when neither <main> nor <article> exists', () => {
    const html = '<!DOCTYPE html><html><body><p>Paragraph in simple body.</p></body></html>';
    const result = extractHtmlContent(html);
    assert.match(result.text, /Paragraph in simple body\./);
  });

  await t.test('42-46. noise elements excluded: script, style, nav, footer, iframe, svg, canvas, noscript, form', () => {
    const html = readFixture('noisy.html');
    const result = extractHtmlContent(html);
    // 42. script
    assert.doesNotMatch(result.text, /malicious or irrelevant/);
    // 43. style
    assert.doesNotMatch(result.text, /background/);
    // 44. nav
    assert.doesNotMatch(result.text, /Home/);
    assert.doesNotMatch(result.text, /About/);
    // 45. footer
    assert.doesNotMatch(result.text, /Copyright info/);
    // 46. iframe, noscript, form
    assert.doesNotMatch(result.text, /embed/);
    assert.doesNotMatch(result.text, /enable JS/);
    assert.doesNotMatch(result.text, /Search/);
  });

  await t.test('47. Unicode Arabic preserved without corruption or translation', () => {
    const html = readFixture('unicode.html');
    const result = extractHtmlContent(html);
    assert.match(result.text, /الذكاء الاصطناعي يمثل قفزة نوعية في معالجة اللغات الطبيعية\./);
  });

  await t.test('48. Unicode Urdu preserved without corruption or transliteration', () => {
    const html = readFixture('unicode.html');
    const result = extractHtmlContent(html);
    assert.match(result.text, /جدید مصنوعی ذہانت/);
    assert.match(result.text, /مصنوعی ذہانت انسانی تاریخ میں ایک نیا باب رقم کر رہی ہے۔/);
  });

  await t.test('49. repeated whitespace normalized', () => {
    const html = '<!DOCTYPE html><html><body><p>Word1     Word2\t\t\tWord3</p>\n\n\n\n<p>Next paragraph</p></body></html>';
    const result = extractHtmlContent(html);
    assert.equal(result.text, 'Word1 Word2 Word3\n\nNext paragraph');
  });

  await t.test('50-51. text above max chars truncated deterministically and truncated flag is true', () => {
    const html = readFixture('article.html');
    const result = extractHtmlContent(html, { maxTextChars: 40 });
    assert.equal(result.text.length, 40);
    assert.equal(result.truncated, true);
    assert.equal(result.extractedCharacters, 40);
  });

  await t.test('52. truncated flag false when complete text is within limit', () => {
    const html = readFixture('article.html');
    const result = extractHtmlContent(html, { maxTextChars: 5000 });
    assert.equal(result.truncated, false);
    assert.equal(result.extractedCharacters, result.text.length);
  });

  await t.test('53. empty meaningful text -> NO_READABLE_CONTENT', () => {
    const html = readFixture('empty.html');
    assert.throws(
      () => extractHtmlContent(html),
      (err) => err instanceof PageReaderError && err.code === 'NO_READABLE_CONTENT'
    );

    assert.throws(
      () => extractHtmlContent('   '),
      (err) => err instanceof PageReaderError && err.code === 'NO_READABLE_CONTENT'
    );
  });
});
