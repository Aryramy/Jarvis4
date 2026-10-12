import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTargetFromElements,
  normalizeTargetText,
  generateSnapshotToken,
  createSafeElementSummary,
  TargetResolutionError,
  SUPPORTED_KINDS
} from '../../src/browser/targetResolver.js';
import { inspectHtmlString } from '../../src/browser/pageInspection.js';
import { BrowserManager } from '../../src/browser/browserManager.js';

describe('Target Resolver Unit Tests (Brick 29)', () => {
  describe('Normalization (Section 44)', () => {
    test('10. leading/trailing whitespace ignored', () => {
      assert.equal(normalizeTargetText('   Submit   '), 'submit');
    });

    test('11. repeated whitespace normalized', () => {
      assert.equal(normalizeTargetText('Search   the    Web'), 'search the web');
    });

    test('12. case-insensitive comparison where intended', () => {
      assert.equal(normalizeTargetText('SEARCH'), normalizeTargetText('search'));
    });

    test('13. Unicode preserved', () => {
      const mixed = 'English & Français & Español';
      assert.equal(normalizeTargetText(mixed), 'english & français & español');
    });

    test('14. Arabic text resolves with exact NFC preservation', () => {
      const arabic = 'تسجيل الدخول';
      assert.equal(normalizeTargetText(arabic), arabic.normalize('NFC'));
    });

    test('15. Urdu text resolves with exact NFC preservation', () => {
      const urdu = 'تلاش کریں';
      assert.equal(normalizeTargetText(urdu), urdu.normalize('NFC'));
    });

    test('16. punctuation is not destructively stripped', () => {
      const punct = 'Submit (Now)! & Next ->';
      assert.equal(normalizeTargetText(punct), 'submit (now)! & next ->');
    });
  });

  describe('Exact Targeting (Section 43)', () => {
    test('1. unique button by accessible name', () => {
      const html = '<div><button type="button">Submit</button><button type="button">Cancel</button></div>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'Submit' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.confidence, 'high');
      assert.equal(res.match.accessibleName, 'Submit');
      assert.ok(res.matchedBy.includes('accessibleName'));
    });

    test('2. unique link by visible text', () => {
      const html = '<div><a href="/index">Return to index</a><a href="/about">About Us</a></div>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'link', visibleText: 'Return to index' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.text, 'Return to index');
      assert.equal(res.match.href, '/index');
    });

    test('3. unique heading by visible text', () => {
      const html = '<div><h1>Welcome Home</h1><h2>Dashboard</h2></div>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'heading', name: 'Welcome Home' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.text, 'Welcome Home');
    });

    test('4. input by associated label', () => {
      const html = `
        <form>
          <label for="pwd">Password</label>
          <input type="password" id="pwd" name="user_pwd" />
        </form>
      `;
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'input', label: 'Password' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.label, 'Password');
      assert.equal(res.match.inputType, 'password');
    });

    test('5. input by accessible name', () => {
      const html = '<input type="text" aria-label="Search Query" />';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'input', accessibleName: 'Search Query' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.accessibleName, 'Search Query');
    });

    test('6. input by placeholder when stronger signal absent', () => {
      const html = '<input type="text" placeholder="Type here to search..." />';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'input', placeholder: 'Type here to search...' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.placeholder, 'Type here to search...');
    });

    test('7. textarea by label', () => {
      const html = '<label for="comm">Comments</label><textarea id="comm" name="comments"></textarea>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'textarea', label: 'Comments' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.label, 'Comments');
    });

    test('8. select by label', () => {
      const html = '<label for="country">Country</label><select id="country"><option>USA</option></select>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'select', label: 'Country' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.label, 'Country');
    });

    test('9. form by safe structural metadata', () => {
      const html = '<form action="/api/login" method="POST" id="loginForm"><input type="text" /></form>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'form', form: '/api/login' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.action, '/api/login');
      assert.equal(res.match.method, 'POST');
    });
  });

  describe('Priority & Disambiguation (Section 45 & 46)', () => {
    test('17. exact accessible name beats partial text', () => {
      const html = `
        <div>
          <button type="button">Submit Request</button>
          <button type="button" aria-label="Submit">Submit Fast</button>
        </div>
      `;
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', accessibleName: 'Submit' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.accessibleName, 'Submit');
    });

    test('18. label beats placeholder', () => {
      const html = `
        <div>
          <label for="i1">Email</label>
          <input type="text" id="i1" placeholder="Username" />
          <label for="i2">Username</label>
          <input type="text" id="i2" placeholder="Your Name" />
        </div>
      `;
      const snap = inspectHtmlString(html);
      // Query "Username" should match the second input (label match, score 90) over the first input (placeholder match, score 70)
      const res = resolveTargetFromElements(snap.elements, { kind: 'input', name: 'Username' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.label, 'Username');
    });

    test('19. exact visible text beats contains match', () => {
      const html = `
        <div>
          <a href="/login-admin">Login to Admin Portal</a>
          <a href="/login">Login</a>
        </div>
      `;
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'link', visibleText: 'Login' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.text, 'Login');
      assert.equal(res.match.href, '/login');
    });

    test('20. strong semantic match beats weaker attribute match', () => {
      const html = `
        <div>
          <button type="button" name="submit-btn">Proceed</button>
          <button type="button">submit-btn</button>
        </div>
      `;
      const snap = inspectHtmlString(html);
      // Querying name="submit-btn" should prefer visibleText/accessibleName over the name attribute
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'submit-btn' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.text, 'submit-btn');
    });

    test('21. DOM order does not override stronger semantic evidence', () => {
      const html = `
        <div>
          <input type="text" placeholder="Search" />
          <label for="s2">Search</label>
          <input type="text" id="s2" placeholder="Filter articles" />
        </div>
      `;
      const snap = inspectHtmlString(html);
      // Second input has label "Search" (score 90), first has placeholder "Search" (score 70)
      const res = resolveTargetFromElements(snap.elements, { kind: 'input', name: 'Search' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.label, 'Search');
    });

    test('22. two equally matching buttons -> TARGET_AMBIGUOUS', () => {
      const html = `
        <div>
          <button type="button">Continue</button>
          <button type="button">Continue</button>
        </div>
      `;
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'Continue' });
      assert.equal(res.success, false);
      assert.equal(res.resolution, 'ambiguous');
      assert.equal(res.error, 'TARGET_AMBIGUOUS');
      assert.equal(res.code, 'TARGET_AMBIGUOUS');
      assert.equal(res.candidateCount, 2);
      assert.equal(res.candidates.length, 2);
    });

    test('23. two equally matching links -> TARGET_AMBIGUOUS', () => {
      const html = `
        <div>
          <a href="/page1">Read More</a>
          <a href="/page2">Read More</a>
        </div>
      `;
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'link', visibleText: 'Read More' });
      assert.equal(res.success, false);
      assert.equal(res.resolution, 'ambiguous');
      assert.equal(res.candidateCount, 2);
    });

    test('24. candidate count returned', () => {
      const html = `
        <div>
          <button type="button">Delete</button>
          <button type="button">Delete</button>
          <button type="button">Delete</button>
        </div>
      `;
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'Delete' });
      assert.equal(res.candidateCount, 3);
      assert.equal(res.candidates.length, 3);
    });

    test('25. safe candidate summaries returned', () => {
      const html = `
        <div>
          <button type="button">Edit</button>
          <button type="button">Edit</button>
        </div>
      `;
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'Edit' });
      assert.ok(Array.isArray(res.candidates));
      assert.equal(res.candidates[0].kind, 'button');
      assert.equal(res.candidates[0].text, 'Edit');
      assert.ok(res.candidates[0].targetId);
    });

    test('26. first DOM candidate is NOT arbitrarily selected when tied', () => {
      const html = `
        <div>
          <button type="button">Save</button>
          <button type="button">Save</button>
        </div>
      `;
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'Save' });
      assert.equal(res.success, false);
      assert.equal(res.resolution, 'ambiguous');
      assert.strictEqual(res.match, undefined);
    });

    test('27. additional semantic signal (form context) can disambiguate', () => {
      const html = `
        <div>
          <form action="/checkout" id="checkoutForm">
            <button type="button">Continue</button>
          </form>
          <form action="/billing" id="billingForm">
            <button type="button">Continue</button>
          </form>
        </div>
      `;
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, {
        kind: 'button',
        name: 'Continue',
        form: 'billing'
      });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.formAction, '/billing');
    });
  });

  describe('Not Found Handling (Section 47)', () => {
    test('28. no match -> TARGET_NOT_FOUND', () => {
      const html = '<div><button type="button">Submit</button></div>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'Nonexistent' });
      assert.equal(res.success, false);
      assert.equal(res.resolution, 'not_found');
      assert.equal(res.error, 'TARGET_NOT_FOUND');
      assert.equal(res.candidateCount, 0);
    });

    test('29-31. zero navigation, interaction, or AI fallback on not found', () => {
      const res = resolveTargetFromElements([], { kind: 'button', name: 'Anything' });
      assert.equal(res.resolution, 'not_found');
      assert.equal(res.candidateCount, 0);
    });
  });

  describe('Visibility & State (Section 48 & 49)', () => {
    test('32. visible element eligible', () => {
      const html = '<div><button type="button">Active</button></div>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'Active' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
    });

    test('33. display:none excluded', () => {
      const html = '<div><button style="display:none">Hidden Button</button></div>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'Hidden Button' });
      assert.equal(res.resolution, 'not_found');
    });

    test('34. visibility:hidden excluded', () => {
      const html = '<div><button style="visibility:hidden">Ghost Button</button></div>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'Ghost Button' });
      assert.equal(res.resolution, 'not_found');
    });

    test('35. hidden attribute excluded', () => {
      const html = '<div><button hidden>Invisible</button></div>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'Invisible' });
      assert.equal(res.resolution, 'not_found');
    });

    test('36. non-visible template/script/style excluded', () => {
      const html = '<template><button>Template Button</button></template>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'Template Button' });
      assert.equal(res.resolution, 'not_found');
    });

    test('37. disabled state returned observationally', () => {
      const html = '<button type="button" disabled>Disabled Action</button>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'Disabled Action' });
      assert.equal(res.success, true);
      assert.equal(res.match.disabled, true);
    });

    test('38. checked state returned observationally', () => {
      const html = '<label><input type="checkbox" name="agree" checked /> Agreed</label>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'input', label: 'Agreed' });
      assert.equal(res.success, true);
      assert.equal(res.match.checked, true);
    });

    test('39. required state preserved', () => {
      const html = '<label for="em">Email</label><input type="email" id="em" required />';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'input', label: 'Email' });
      assert.equal(res.success, true);
      assert.equal(res.match.required, true);
    });

    test('40. input type preserved', () => {
      const html = '<label for="r1">Option A</label><input type="radio" id="r1" name="opt" />';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'input', label: 'Option A' });
      assert.equal(res.success, true);
      assert.equal(res.match.inputType, 'radio');
    });

    test('41. href preserved for link summary', () => {
      const html = '<a href="/help/faq">Help & FAQ</a>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'link', visibleText: 'Help & FAQ' });
      assert.equal(res.success, true);
      assert.equal(res.match.href, '/help/faq');
    });

    test('42. form method/action safe metadata preserved', () => {
      const html = '<form action="/submit-survey" method="POST"><button>Submit Survey</button></form>';
      const snap = inspectHtmlString(html);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'Submit Survey' });
      assert.equal(res.success, true);
      assert.equal(res.match.formAction, '/submit-survey');
      assert.equal(res.match.formMethod, 'POST');
    });
  });

  describe('Privacy Preserved (Section 50)', () => {
    test('43-50. field values, passwords, cookies, tokens strictly omitted', () => {
      const html = `
        <form action="/login" method="POST">
          <label for="u">Username</label>
          <input type="text" id="u" name="user" value="super_secret_username" />
          <label for="p">Password</label>
          <input type="password" id="p" name="pwd" value="super_secret_password_123" />
          <label for="t">Bio</label>
          <textarea id="t" name="bio">Secret user biography</textarea>
          <input type="hidden" name="csrf" value="token_xyz" />
        </form>
      `;
      const snap = inspectHtmlString(html);
      const resPwd = resolveTargetFromElements(snap.elements, { kind: 'input', label: 'Password' });
      assert.equal(resPwd.success, true);
      assert.strictEqual(resPwd.match.value, undefined);
      assert.ok(!JSON.stringify(resPwd).includes('super_secret_password_123'));
      assert.ok(!JSON.stringify(resPwd).includes('super_secret_username'));
      assert.ok(!JSON.stringify(resPwd).includes('Secret user biography'));
      assert.ok(!JSON.stringify(resPwd).includes('token_xyz'));
    });
  });

  describe('Snapshot Staleness & Invalidation (Section 51 & 52)', async () => {
    function createMockBrowser() {
      const listeners = {};
      const pageListeners = {};
      const mockPage = {
        _closed: false,
        _url: 'about:blank',
        _title: 'Blank Page',
        url() { return this._url; },
        async title() { return this._title; },
        async goto(url) { this._url = url; return { status: () => 200 }; },
        async goBack() { return { status: () => 200 }; },
        async goForward() { return { status: () => 200 }; },
        async reload() { return { status: () => 200 }; },
        async evaluate() {
          return {
            visibleText: 'Home Page Content',
            elements: [
              { kind: 'button', tag: 'button', text: 'Submit', accessibleName: 'Submit' }
            ]
          };
        },
        async close() {
          this._closed = true;
          if (pageListeners['close']) pageListeners['close']();
        },
        isClosed() { return this._closed; },
        on(event, cb) { pageListeners[event] = cb; },
        async route() {},
        async unroute() {}
      };
      const mockContext = {
        async newPage() { return mockPage; },
        async close() {},
        on() {}
      };
      const mockBrowser = {
        isConnected() { return true; },
        async newContext() { return mockContext; },
        async close() { if (listeners['disconnected']) listeners['disconnected'](); },
        on(event, cb) { listeners[event] = cb; }
      };
      return { mockBrowser, mockPage };
    }

    test('51. navigation invalidates prior snapshot token/version', async () => {
      const { mockBrowser } = createMockBrowser();
      const bm = new BrowserManager({ launcher: async () => mockBrowser });
      await bm.launch();

      const initialToken = bm.snapshotToken;
      const initialVersion = bm.snapshotVersion;
      assert.ok(initialToken);
      assert.equal(initialVersion, 1);

      await bm.navigate('https://example.com');
      const nextToken = bm.snapshotToken;
      const nextVersion = bm.snapshotVersion;

      assert.notEqual(initialToken, nextToken);
      assert.equal(nextVersion, initialVersion + 1);
      assert.equal(bm.isSnapshotTokenValid(initialToken), false);
      assert.equal(bm.isSnapshotTokenValid(nextToken), true);

      await bm.close();
    });

    test('52. manual page close invalidates target resolution state', async () => {
      const { mockBrowser, mockPage } = createMockBrowser();
      const bm = new BrowserManager({ launcher: async () => mockBrowser });
      await bm.launch();

      assert.ok(bm.snapshotToken);
      await mockPage.close();

      assert.strictEqual(bm.snapshotToken, null);
      assert.equal(bm.snapshotVersion, 0);

      await assert.rejects(
        async () => bm.resolveTarget({ kind: 'button', name: 'Submit' }),
        /Browser is not running/
      );
    });

    test('53. browser close invalidates target state', async () => {
      const { mockBrowser } = createMockBrowser();
      const bm = new BrowserManager({ launcher: async () => mockBrowser });
      await bm.launch();

      assert.ok(bm.snapshotToken);
      await bm.close();

      assert.strictEqual(bm.snapshotToken, null);
      assert.equal(bm.snapshotVersion, 0);
    });

    test('54. fresh browser launch does not reuse old target state', async () => {
      const { mockBrowser } = createMockBrowser();
      const bm = new BrowserManager({ launcher: async () => mockBrowser });
      await bm.launch();
      const token1 = bm.snapshotToken;
      await bm.close();

      await bm.launch();
      const token2 = bm.snapshotToken;

      assert.notEqual(token1, token2);
      await bm.close();
    });

    test('55. document replacement / reload invalidates old snapshot', async () => {
      const { mockBrowser } = createMockBrowser();
      const bm = new BrowserManager({ launcher: async () => mockBrowser });
      await bm.launch();
      const t1 = bm.snapshotToken;

      await bm.refresh();
      const t2 = bm.snapshotToken;

      assert.notEqual(t1, t2);
      await bm.close();
    });

    test('56. same semantic element can be re-resolved after re-render with fresh snapshot', async () => {
      const { mockBrowser } = createMockBrowser();
      const bm = new BrowserManager({ launcher: async () => mockBrowser });
      await bm.launch();

      const res1 = await bm.resolveTarget({ kind: 'button', name: 'Submit' });
      assert.equal(res1.success, true);
      assert.equal(res1.resolution, 'unique');
      const token1 = res1.snapshotToken;

      // Invalidate snapshot (e.g. dynamic reload/re-render)
      bm._invalidateSnapshot();

      const res2 = await bm.resolveTarget({ kind: 'button', name: 'Submit' });
      assert.equal(res2.success, true);
      assert.equal(res2.resolution, 'unique');
      const token2 = res2.snapshotToken;

      assert.notEqual(token1, token2);
      await bm.close();
    });

    test('57. raw ElementHandle is not persisted as long-term public target', async () => {
      const { mockBrowser } = createMockBrowser();
      const bm = new BrowserManager({ launcher: async () => mockBrowser });
      await bm.launch();

      const res = await bm.resolveTarget({ kind: 'button', name: 'Submit' });
      assert.strictEqual(res.match.handle, undefined);
      assert.strictEqual(res.match.element, undefined);
      assert.strictEqual(res.match.elementHandle, undefined);
      assert.strictEqual(res.match.jsHandle, undefined);
      assert.strictEqual(res.match.selector, undefined);
      assert.strictEqual(res.match.xpath, undefined);

      await bm.close();
    });

    test('58-65. zero click, fill, type, press, selectOption, navigation, or popups during resolveTarget', async () => {
      const { mockBrowser } = createMockBrowser();
      const bm = new BrowserManager({ launcher: async () => mockBrowser });
      await bm.launch();

      const res = await bm.resolveTarget({ kind: 'button', name: 'Submit' });
      assert.equal(res.success, true);

      // Verify page URL did not change
      assert.equal(bm.getStatus().currentUrl, 'about:blank');
      await bm.close();
    });
  });

  describe('Real Selenium Form Regression Model (Section 54)', () => {
    const seleniumHtml = `
      <!DOCTYPE html>
      <html>
      <head><title>Web form</title></head>
      <body>
        <main>
          <h1>Web form</h1>
          <form action="./submitted-form.html" method="get">
            <div>
              <label for="my-text-id">Text input</label>
              <input type="text" name="my-text" id="my-text-id" value="secret_text" />
            </div>
            <div>
              <label for="my-password">Password</label>
              <input type="password" name="my-password" id="my-password" value="secret_pass" />
            </div>
            <div>
              <label for="my-textarea">Textarea</label>
              <textarea name="my-textarea" id="my-textarea">secret_textarea</textarea>
            </div>
            <div>
              <label for="my-select">Dropdown (select)</label>
              <select name="my-select" id="my-select">
                <option selected>Open this select menu</option>
                <option value="1">One</option>
              </select>
            </div>
            <div>
              <label for="my-check-1">Checked checkbox</label>
              <input type="checkbox" name="my-check" id="my-check-1" checked />
            </div>
            <div>
              <label for="my-radio-1">Default radio</label>
              <input type="radio" name="my-radio" id="my-radio-1" checked />
            </div>
            <button type="submit">Submit</button>
          </form>
          <a href="./index.html">Return to index</a>
        </main>
      </body>
      </html>
    `;

    test('resolves button: Submit', () => {
      const snap = inspectHtmlString(seleniumHtml);
      const res = resolveTargetFromElements(snap.elements, { kind: 'button', name: 'Submit' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.accessibleName, 'Submit');
    });

    test('resolves input: Password without exposing value', () => {
      const snap = inspectHtmlString(seleniumHtml);
      const res = resolveTargetFromElements(snap.elements, { kind: 'input', label: 'Password' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.inputType, 'password');
      assert.strictEqual(res.match.value, undefined);
      assert.ok(!JSON.stringify(res).includes('secret_pass'));
    });

    test('resolves input: Text input without exposing value', () => {
      const snap = inspectHtmlString(seleniumHtml);
      const res = resolveTargetFromElements(snap.elements, { kind: 'input', label: 'Text input' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.strictEqual(res.match.value, undefined);
      assert.ok(!JSON.stringify(res).includes('secret_text'));
    });

    test('resolves textarea: Textarea without exposing value', () => {
      const snap = inspectHtmlString(seleniumHtml);
      const res = resolveTargetFromElements(snap.elements, { kind: 'textarea', label: 'Textarea' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.strictEqual(res.match.value, undefined);
      assert.ok(!JSON.stringify(res).includes('secret_textarea'));
    });

    test('resolves select: Dropdown (select)', () => {
      const snap = inspectHtmlString(seleniumHtml);
      const res = resolveTargetFromElements(snap.elements, { kind: 'select', label: 'Dropdown (select)' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.selectedText, 'Open this select menu');
    });

    test('resolves link: Return to index', () => {
      const snap = inspectHtmlString(seleniumHtml);
      const res = resolveTargetFromElements(snap.elements, { kind: 'link', visibleText: 'Return to index' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.href, './index.html');
    });

    test('resolves checkbox: Checked checkbox', () => {
      const snap = inspectHtmlString(seleniumHtml);
      const res = resolveTargetFromElements(snap.elements, { kind: 'input', label: 'Checked checkbox' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.checked, true);
    });

    test('resolves radio: Default radio', () => {
      const snap = inspectHtmlString(seleniumHtml);
      const res = resolveTargetFromElements(snap.elements, { kind: 'input', label: 'Default radio' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.checked, true);
    });
  });

  describe('Wikipedia-Style Regression Model (Section 55)', () => {
    const wikiHtml = `
      <!DOCTYPE html>
      <html>
      <head><title>Wikipedia, the free encyclopedia</title></head>
      <body>
        <header>
          <h1>Wikipedia</h1>
        </header>
        <main>
          <div class="central-featured">
            <a href="https://en.wikipedia.org/" class="link-box"><strong>English</strong></a>
            <a href="https://ja.wikipedia.org/" class="link-box"><strong>日本語</strong></a>
            <a href="https://es.wikipedia.org/" class="link-box"><strong>Español</strong></a>
            <a href="https://de.wikipedia.org/" class="link-box"><strong>Deutsch</strong></a>
          </div>
          <form action="/search" method="get">
            <label for="searchInput">Search Wikipedia</label>
            <input type="search" id="searchInput" name="search" placeholder="Search Wikipedia" />
            <select name="language" id="searchLanguage" aria-label="Language">
              <option value="en" selected>EN</option>
              <option value="de">DE</option>
            </select>
            <button type="submit" aria-label="Search">Search</button>
          </form>
        </main>
      </body>
      </html>
    `;

    test('resolves Wikipedia heading', () => {
      const snap = inspectHtmlString(wikiHtml);
      const res = resolveTargetFromElements(snap.elements, { kind: 'heading', name: 'Wikipedia' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.text, 'Wikipedia');
    });

    test('resolves search input by label/accessibility semantics', () => {
      const snap = inspectHtmlString(wikiHtml);
      const res = resolveTargetFromElements(snap.elements, { kind: 'input', label: 'Search Wikipedia' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.inputType, 'search');
    });

    test('resolves English link by visible text', () => {
      const snap = inspectHtmlString(wikiHtml);
      const res = resolveTargetFromElements(snap.elements, { kind: 'link', visibleText: 'English' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.href, 'https://en.wikipedia.org/');
    });

    test('resolves language select without hardcoded CSS selectors', () => {
      const snap = inspectHtmlString(wikiHtml);
      const res = resolveTargetFromElements(snap.elements, { kind: 'select', accessibleName: 'Language' });
      assert.equal(res.success, true);
      assert.equal(res.resolution, 'unique');
      assert.equal(res.match.selectedText, 'EN');
    });
  });
});
