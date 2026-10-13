import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, truncate, extractDomSnapshot, inspectHtmlString } from '../../src/browser/pageInspection.js';

describe('Page Inspection Unit Tests (Brick 28)', () => {
  describe('cleanText & truncate Helpers', () => {
    test('cleanText preserves single lines and collapses excessive horizontal whitespace', () => {
      assert.equal(cleanText('  Hello    World!  '), 'Hello World!');
    });

    test('cleanText collapses consecutive blank lines beyond one', () => {
      const input = 'Line 1\n\n\n\n\nLine 2';
      assert.equal(cleanText(input), 'Line 1\n\nLine 2');
    });

    test('truncate respects exact character limit', () => {
      assert.equal(truncate('abcdef', 3), 'abc');
      assert.equal(truncate('abc', 5), 'abc');
    });
  });

  describe('32. UNIT TESTS — TEXT BOUNDING', () => {
    test('10. short text unchanged', () => {
      const html = '<div><p>Simple short text.</p></div>';
      const snap = inspectHtmlString(html, { maxTextChars: 12000 });
      assert.equal(snap.visibleText, 'Simple short text.');
      assert.equal(snap.textTruncated, false);
    });

    test('11. excessive whitespace normalized safely', () => {
      const html = '<div><p>   Multiple   spaces   and \t tabs   \n\n\n   across lines.   </p></div>';
      const snap = inspectHtmlString(html);
      assert.equal(snap.visibleText, 'Multiple spaces and tabs\n\nacross lines.');
    });

    test('12. text over limit truncated deterministically', () => {
      const html = '<div><p>0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ</p></div>';
      const snap = inspectHtmlString(html, { maxTextChars: 10 });
      assert.equal(snap.visibleText, '0123456789');
      assert.equal(snap.visibleText.length, 10);
      assert.equal(snap.textTruncated, true);
    });

    test('13. textTruncated false below limit', () => {
      const html = '<p>Hello world</p>';
      const snap = inspectHtmlString(html, { maxTextChars: 100 });
      assert.equal(snap.textTruncated, false);
    });

    test('14. textTruncated true above limit', () => {
      const html = '<p>This sentence has thirty characters.</p>';
      const snap = inspectHtmlString(html, { maxTextChars: 15 });
      assert.equal(snap.textTruncated, true);
    });

    test('15. exact configured text limit honored', () => {
      const longText = 'A'.repeat(500);
      const html = `<p>${longText}</p>`;
      const snap = inspectHtmlString(html, { maxTextChars: 250 });
      assert.equal(snap.visibleText.length, 250);
      assert.equal(snap.visibleText, 'A'.repeat(250));
    });

    test('16. script contents excluded from visible text', () => {
      const html = '<div><p>Visible Content</p><script>console.log("SECRET_SCRIPT_DATA");</script></div>';
      const snap = inspectHtmlString(html);
      assert.ok(!snap.visibleText.includes('SECRET_SCRIPT_DATA'));
      assert.ok(!snap.visibleText.includes('console.log'));
      assert.equal(snap.visibleText, 'Visible Content');
    });

    test('17. style contents excluded from visible text', () => {
      const html = '<div><style>body { color: red; }</style><p>Styled Content</p></div>';
      const snap = inspectHtmlString(html);
      assert.ok(!snap.visibleText.includes('body { color: red; }'));
      assert.equal(snap.visibleText, 'Styled Content');
    });
  });

  describe('33. UNIT TESTS — ELEMENT INVENTORY', () => {
    test('18. heading extraction', () => {
      const html = '<h1>Main Title</h1><h2>Subtitle</h2><div role="heading">Custom Heading</div>';
      const snap = inspectHtmlString(html);
      const headings = snap.elements.filter(e => e.kind === 'heading');
      assert.equal(headings.length, 3);
      assert.equal(headings[0].tag, 'h1');
      assert.equal(headings[0].text, 'Main Title');
      assert.equal(headings[1].tag, 'h2');
      assert.equal(headings[1].text, 'Subtitle');
      assert.equal(headings[2].role, 'heading');
      assert.equal(headings[2].text, 'Custom Heading');
    });

    test('19. link extraction', () => {
      const html = '<a href="https://example.com/docs">Documentation</a><div role="link">Role Link</div>';
      const snap = inspectHtmlString(html);
      const links = snap.elements.filter(e => e.kind === 'link');
      assert.equal(links.length, 2);
      assert.equal(links[0].tag, 'a');
      assert.equal(links[0].href, 'https://example.com/docs');
      assert.equal(links[0].text, 'Documentation');
      assert.equal(links[1].role, 'link');
    });

    test('20. button extraction', () => {
      const html = '<button type="button">Submit Request</button><div role="button">Custom Button</div>';
      const snap = inspectHtmlString(html);
      const buttons = snap.elements.filter(e => e.kind === 'button');
      assert.equal(buttons.length, 2);
      assert.equal(buttons[0].tag, 'button');
      assert.equal(buttons[0].text, 'Submit Request');
      assert.equal(buttons[1].role, 'button');
      assert.equal(buttons[1].text, 'Custom Button');
    });

    test('21. text input metadata', () => {
      const html = '<label for="uname">Username</label><input type="text" id="uname" name="username" placeholder="Enter username" />';
      const snap = inspectHtmlString(html);
      const inputs = snap.elements.filter(e => e.kind === 'input');
      assert.equal(inputs.length, 1);
      assert.equal(inputs[0].inputType, 'text');
      assert.equal(inputs[0].name, 'username');
      assert.equal(inputs[0].placeholder, 'Enter username');
      assert.equal(inputs[0].label, 'Username');
      assert.strictEqual(inputs[0].value, undefined);
    });

    test('22. checkbox/radio metadata', () => {
      const html = `
        <label><input type="checkbox" name="agree" checked /> I agree</label>
        <input type="radio" name="plan" id="p1" checked />
        <input type="radio" name="plan" id="p2" />
      `;
      const snap = inspectHtmlString(html);
      const inputs = snap.elements.filter(e => e.kind === 'input');
      assert.equal(inputs.length, 3);
      assert.equal(inputs[0].inputType, 'checkbox');
      assert.equal(inputs[0].checked, true);
      assert.equal(inputs[1].inputType, 'radio');
      assert.equal(inputs[1].checked, true);
      assert.equal(inputs[2].inputType, 'radio');
      assert.equal(inputs[2].checked, false);
    });

    test('23. textarea metadata', () => {
      const html = '<label for="notes">Notes</label><textarea id="notes" name="notes" placeholder="Enter feedback">Secret User Content</textarea>';
      const snap = inspectHtmlString(html);
      const textareas = snap.elements.filter(e => e.kind === 'textarea');
      assert.equal(textareas.length, 1);
      assert.equal(textareas[0].name, 'notes');
      assert.equal(textareas[0].placeholder, 'Enter feedback');
      assert.equal(textareas[0].label, 'Notes');
      assert.strictEqual(textareas[0].value, undefined);
      assert.strictEqual(textareas[0].text, undefined);
    });

    test('24. select metadata', () => {
      const html = `
        <label for="country">Country</label>
        <select id="country" name="country">
          <option value="US">United States</option>
          <option value="QA" selected>Qatar</option>
        </select>
      `;
      const snap = inspectHtmlString(html);
      const selects = snap.elements.filter(e => e.kind === 'select');
      assert.equal(selects.length, 1);
      assert.equal(selects[0].name, 'country');
      assert.equal(selects[0].label, 'Country');
      assert.equal(selects[0].selectedText, 'Qatar');
      assert.strictEqual(selects[0].value, undefined);
    });

    test('25. form metadata', () => {
      const html = `
        <form method="post" action="/api/login">
          <input type="text" name="user" />
          <input type="password" name="pass" />
          <button type="submit">Log in</button>
        </form>
      `;
      const snap = inspectHtmlString(html);
      const forms = snap.elements.filter(e => e.kind === 'form');
      assert.equal(forms.length, 1);
      assert.equal(forms[0].method, 'POST');
      assert.equal(forms[0].action, '/api/login');
      assert.equal(forms[0].fieldCount, 3);
    });

    test('26. disabled element state', () => {
      const html = `
        <button disabled>Disabled Button</button>
        <button>Active Button</button>
        <input type="text" disabled />
      `;
      const snap = inspectHtmlString(html);
      assert.equal(snap.elements[0].disabled, true);
      assert.strictEqual(snap.elements[1].disabled, undefined);
      assert.equal(snap.elements[2].disabled, true);
    });

    test('27. required element state', () => {
      const html = `
        <input type="text" required />
        <input type="text" />
      `;
      const snap = inspectHtmlString(html);
      assert.equal(snap.elements[0].required, true);
      assert.strictEqual(snap.elements[1].required, undefined);
    });

    test('28. deterministic DOM ordering', () => {
      const html = `
        <h1>Title</h1>
        <p><a href="/one">First Link</a></p>
        <form action="/submit">
          <input type="text" placeholder="Name" />
          <button type="submit">Submit</button>
        </form>
        <a href="/two">Second Link</a>
      `;
      const snap = inspectHtmlString(html);
      const sequence = snap.elements.map(e => e.kind);
      assert.deepEqual(sequence, ['heading', 'link', 'form', 'input', 'button', 'link']);
    });
  });

  describe('34. UNIT TESTS — VISIBILITY', () => {
    test('29. display:none excluded', () => {
      const html = `
        <p>Visible</p>
        <div style="display:none;"><button>Hidden Button</button></div>
        <p style="display: none;">Hidden Paragraph</p>
      `;
      const snap = inspectHtmlString(html);
      assert.ok(!snap.visibleText.includes('Hidden'));
      assert.equal(snap.elements.length, 0);
    });

    test('30. visibility:hidden excluded', () => {
      const html = `
        <button style="visibility:hidden;">Invisible Button</button>
        <a href="/hidden" style="visibility: hidden;">Hidden Link</a>
        <button>Visible Button</button>
      `;
      const snap = inspectHtmlString(html);
      assert.equal(snap.elements.length, 1);
      assert.equal(snap.elements[0].text, 'Visible Button');
    });

    test('31. hidden attribute excluded', () => {
      const html = `
        <h1 hidden>Hidden Heading</h1>
        <div hidden><a href="/test">Hidden Link</a></div>
        <h2>Visible Heading</h2>
      `;
      const snap = inspectHtmlString(html);
      assert.equal(snap.elements.length, 1);
      assert.equal(snap.elements[0].text, 'Visible Heading');
    });

    test('32. non-visible zero-size element excluded', () => {
      const html = `
        <button style="width:0;height:0;">Zero Button</button>
        <button>Normal Button</button>
      `;
      const snap = inspectHtmlString(html);
      assert.equal(snap.elements.length, 1);
      assert.equal(snap.elements[0].text, 'Normal Button');
    });

    test('33. script excluded from inventory', () => {
      const html = '<script>var x = 10;</script><button>Click</button>';
      const snap = inspectHtmlString(html);
      assert.equal(snap.elements.length, 1);
      assert.equal(snap.elements[0].kind, 'button');
    });

    test('34. style excluded from inventory', () => {
      const html = '<style>.btn { color: blue; }</style><button>Click</button>';
      const snap = inspectHtmlString(html);
      assert.equal(snap.elements.length, 1);
      assert.equal(snap.elements[0].kind, 'button');
    });

    test('35. template excluded from inventory', () => {
      const html = '<template><button>Template Button</button></template><button>Live Button</button>';
      const snap = inspectHtmlString(html);
      assert.equal(snap.elements.length, 1);
      assert.equal(snap.elements[0].text, 'Live Button');
    });
  });

  describe('35. UNIT TESTS — PRIVACY', () => {
    test('36. text input value NOT returned', () => {
      const html = '<input type="text" name="secret_field" value="my_secret_text" />';
      const snap = inspectHtmlString(html);
      assert.strictEqual(snap.elements[0].value, undefined);
      assert.ok(!JSON.stringify(snap).includes('my_secret_text'));
    });

    test('37. password value NOT returned', () => {
      const html = '<input type="password" name="pwd" value="SuperSecretPassword123!" />';
      const snap = inspectHtmlString(html);
      assert.equal(snap.elements[0].inputType, 'password');
      assert.strictEqual(snap.elements[0].value, undefined);
      assert.ok(!JSON.stringify(snap).includes('SuperSecretPassword123!'));
    });

    test('38. email value NOT returned', () => {
      const html = '<input type="email" name="user_email" value="user@confidential.com" />';
      const snap = inspectHtmlString(html);
      assert.equal(snap.elements[0].inputType, 'email');
      assert.strictEqual(snap.elements[0].value, undefined);
      assert.ok(!JSON.stringify(snap).includes('user@confidential.com'));
    });

    test('39. textarea entered value NOT returned', () => {
      const html = '<textarea name="journal">Personal confidential thoughts.</textarea>';
      const snap = inspectHtmlString(html);
      assert.strictEqual(snap.elements[0].value, undefined);
      assert.strictEqual(snap.elements[0].text, undefined);
      assert.ok(!JSON.stringify(snap.elements).includes('Personal confidential thoughts'));
    });

    test('40. hidden input value NOT returned', () => {
      const html = '<input type="hidden" name="session_token" value="abc123token" />';
      const snap = inspectHtmlString(html);
      assert.equal(snap.elements.length, 0);
      assert.ok(!JSON.stringify(snap).includes('abc123token'));
    });

    test('41. CSRF/hidden token value NOT returned', () => {
      const html = '<form><input type="hidden" name="csrf_token" value="SECRET_CSRF_HEX" /><button>Submit</button></form>';
      const snap = inspectHtmlString(html);
      assert.ok(!JSON.stringify(snap).includes('SECRET_CSRF_HEX'));
    });

    test('42-44. cookies, localStorage, sessionStorage NOT returned', () => {
      const html = '<h1>Home</h1><p>Welcome</p>';
      const snap = inspectHtmlString(html);
      assert.strictEqual(snap.cookies, undefined);
      assert.strictEqual(snap.localStorage, undefined);
      assert.strictEqual(snap.sessionStorage, undefined);
    });
  });

  describe('36. UNIT TESTS — ELEMENT LIMITS', () => {
    test('45-48. element limits and deterministic truncation', () => {
      let items = '';
      for (let i = 1; i <= 10; i++) {
        items += `<a href="/page/${i}">Link ${i}</a>\n`;
      }
      const snap = inspectHtmlString(items, { maxElements: 4 });
      assert.equal(snap.returnedElementCount, 4);
      assert.equal(snap.elements.length, 4);
      assert.equal(snap.totalEligibleElementCount, 10);
      assert.equal(snap.elementsTruncated, true);
      assert.equal(snap.elements[0].text, 'Link 1');
      assert.equal(snap.elements[3].text, 'Link 4');
    });

    test('elementsTruncated false below limit', () => {
      const html = '<button>One</button><button>Two</button>';
      const snap = inspectHtmlString(html, { maxElements: 10 });
      assert.equal(snap.elementsTruncated, false);
      assert.equal(snap.returnedElementCount, 2);
      assert.equal(snap.totalEligibleElementCount, 2);
    });

    test('49. individual element text limit honored', () => {
      const html = `<button>${'X'.repeat(500)}</button>`;
      const snap = inspectHtmlString(html, { maxElementTextChars: 50 });
      assert.equal(snap.elements[0].text.length, 50);
      assert.equal(snap.elements[0].text, 'X'.repeat(50));
    });
  });

  describe('37. UNIT TESTS — LINKS', () => {
    test('50-53. visible link text and href observational only', () => {
      const html = '<a href="https://example.com/dest">Safe Link Text</a>';
      const snap = inspectHtmlString(html);
      assert.equal(snap.elements[0].kind, 'link');
      assert.equal(snap.elements[0].text, 'Safe Link Text');
      assert.equal(snap.elements[0].href, 'https://example.com/dest');
    });
  });

  describe('38. UNIT TESTS — FORMS', () => {
    test('54-58. form method, action, non-submission, and omitted field values', () => {
      const html = `
        <form method="post" action="/process">
          <input type="text" name="q" value="query" />
          <input type="hidden" name="token" value="hiddenVal" />
          <button type="submit">Go</button>
        </form>
      `;
      const snap = inspectHtmlString(html);
      const form = snap.elements.find(e => e.kind === 'form');
      assert.ok(form);
      assert.equal(form.method, 'POST');
      assert.equal(form.action, '/process');
      assert.equal(form.fieldCount, 2); // 1 text input + 1 button (hidden excluded)
      assert.ok(!JSON.stringify(snap).includes('query'));
      assert.ok(!JSON.stringify(snap).includes('hiddenVal'));
    });
  });

  describe('DOM Evaluation (extractDomSnapshot)', () => {
    test('extractDomSnapshot runs cleanly with simulated DOM node structure', () => {
      const mockDoc = {
        body: {
          innerText: 'Simulated Page Body'
        },
        querySelectorAll: () => [
          {
            nodeType: 1,
            tagName: 'H1',
            innerText: 'Simulated Heading',
            getAttribute: () => null,
            hasAttribute: () => false
          },
          {
            nodeType: 1,
            tagName: 'A',
            innerText: 'Simulated Link',
            getAttribute: (a) => a === 'href' ? 'https://simulated.test/' : null,
            hasAttribute: () => false
          }
        ]
      };

      const result = extractDomSnapshot({
        _doc: mockDoc,
        maxTextChars: 500,
        maxElements: 50,
        maxElementTextChars: 100
      });

      assert.equal(result.visibleText, 'Simulated Page Body');
      assert.equal(result.returnedElementCount, 2);
      assert.equal(result.elements[0].kind, 'heading');
      assert.equal(result.elements[0].text, 'Simulated Heading');
      assert.equal(result.elements[1].kind, 'link');
      assert.equal(result.elements[1].href, 'https://simulated.test/');
    });
  });

  describe('Selenium-Style Real Web Form Regression Tests (Section 20)', () => {
    const seleniumHtml = `
      <main>
        <h1>Web form</h1>
        <form method="get" action="submitted-form.html">
          <label for="my-text-id">Text input</label>
          <input type="text" id="my-text-id" name="my-text" value="secret text value" placeholder="Enter text" />

          <label for="my-password-id">Password</label>
          <input type="password" id="my-password-id" name="my-password" value="SuperSecretP@ss" />

          <label for="my-textarea-id">Textarea</label>
          <textarea id="my-textarea-id" name="my-textarea" rows="3">Sensitive user entered comments</textarea>

          <label for="my-disabled-id">Disabled input</label>
          <input type="text" id="my-disabled-id" name="my-disabled" value="Disabled text" disabled />

          <label for="my-readonly-id">Readonly input</label>
          <input type="text" id="my-readonly-id" name="my-readonly" value="Readonly text" readonly />

          <label for="my-select-id">Dropdown (select)</label>
          <select id="my-select-id" name="my-select">
            <option value="1" selected>One</option>
            <option value="2">Two</option>
          </select>

          <label for="my-file-id">File input</label>
          <input type="file" id="my-file-id" name="my-file" value="C:\\secret\\file.txt" />

          <label><input type="checkbox" name="my-check-1" checked value="c1" /> Checked checkbox</label>
          <label><input type="checkbox" name="my-check-2" value="c2" /> Default checkbox</label>

          <label><input type="radio" name="my-radio" value="r1" checked /> Checked radio</label>
          <label><input type="radio" name="my-radio" value="r2" /> Default radio</label>

          <input type="hidden" name="csrf-token" value="secret_csrf_token_12345" />

          <input type="color" name="my-color" value="#ff0000" />
          <input type="date" name="my-date" value="2026-10-12" />
          <input type="range" name="my-range" value="5" min="0" max="10" />

          <button type="submit">Submit</button>
        </form>
        <a href="index.html">Return to index</a>
      </main>
    `;

    test('preserves detection of all Selenium-style form categories', () => {
      const snap = inspectHtmlString(seleniumHtml);
      assert.ok(snap.elements.length > 0);

      const heading = snap.elements.find(e => e.kind === 'heading');
      assert.ok(heading, 'heading must be detected');
      assert.equal(heading.text, 'Web form');

      const form = snap.elements.find(e => e.kind === 'form');
      assert.ok(form, 'form must be detected');
      assert.equal(form.method, 'GET');
      assert.equal(form.action, 'submitted-form.html');

      const textInput = snap.elements.find(e => e.kind === 'input' && e.name === 'my-text');
      assert.ok(textInput, 'text input must be detected');
      assert.equal(textInput.inputType, 'text');
      assert.equal(textInput.placeholder, 'Enter text');

      const passwordInput = snap.elements.find(e => e.kind === 'input' && e.inputType === 'password');
      assert.ok(passwordInput, 'password input must be detected');
      assert.equal(passwordInput.name, 'my-password');

      const textarea = snap.elements.find(e => e.kind === 'textarea');
      assert.ok(textarea, 'textarea must be detected');
      assert.equal(textarea.name, 'my-textarea');

      const disabledInput = snap.elements.find(e => e.kind === 'input' && e.name === 'my-disabled');
      assert.ok(disabledInput, 'disabled input must be detected');
      assert.equal(disabledInput.disabled, true);

      const select = snap.elements.find(e => e.kind === 'select');
      assert.ok(select, 'select must be detected');
      assert.equal(select.name, 'my-select');
      assert.equal(select.selectedText, 'One');

      const fileInput = snap.elements.find(e => e.kind === 'input' && e.inputType === 'file');
      assert.ok(fileInput, 'file input must be detected');
      assert.equal(fileInput.name, 'my-file');

      const checkedBox = snap.elements.find(e => e.name === 'my-check-1');
      assert.ok(checkedBox, 'checked checkbox must be detected');
      assert.equal(checkedBox.checked, true);

      const uncheckedBox = snap.elements.find(e => e.name === 'my-check-2');
      assert.ok(uncheckedBox, 'unchecked checkbox must be detected');
      assert.equal(uncheckedBox.checked, false);

      const checkedRadio = snap.elements.find(e => e.name === 'my-radio' && e.checked === true);
      assert.ok(checkedRadio, 'checked radio must be detected');

      const uncheckedRadio = snap.elements.find(e => e.name === 'my-radio' && e.checked === false);
      assert.ok(uncheckedRadio, 'unchecked radio must be detected');

      const button = snap.elements.find(e => e.kind === 'button');
      assert.ok(button, 'button must be detected');
      assert.equal(button.text, 'Submit');

      const link = snap.elements.find(e => e.kind === 'link');
      assert.ok(link, 'link must be detected');
      assert.equal(link.href, 'index.html');
      assert.equal(link.text, 'Return to index');
    });

    test('preserves absolute input and token privacy on Selenium-style form', () => {
      const snap = inspectHtmlString(seleniumHtml);
      const jsonStr = JSON.stringify(snap);

      // Verify no input values, entered textarea text, file paths, or hidden tokens appear
      assert.ok(!jsonStr.includes('secret text value'), 'text input value must be omitted');
      assert.ok(!jsonStr.includes('SuperSecretP@ss'), 'password value must be omitted');
      assert.ok(!jsonStr.includes('Sensitive user entered comments'), 'textarea value must be omitted');
      assert.ok(!jsonStr.includes('Disabled text'), 'disabled input value must be omitted');
      assert.ok(!jsonStr.includes('Readonly text'), 'readonly input value must be omitted');
      assert.ok(!jsonStr.includes('secret\\file.txt'), 'file input path/value must be omitted');
      assert.ok(!jsonStr.includes('secret_csrf_token_12345'), 'hidden CSRF token must be omitted');

      // Verify value property is undefined on all inputs
      for (const el of snap.elements) {
        assert.strictEqual(el.value, undefined, `element ${el.kind} must not have value property`);
      }
    });
  });

  describe('Live Fix D: Native Select Accessible-Name & Label Contamination', () => {
    test('enclosing <label> does not contaminate native select accessibleName or label with option texts', () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <body>
          <label class="form-label">
            Dropdown (select)
            <select class="form-select" name="my-select">
              <option selected>Open this select menu</option>
              <option value="1">One</option>
              <option value="2">Two</option>
              <option value="3">Three</option>
            </select>
          </label>
        </body>
        </html>
      `;

      const snap = inspectHtmlString(html);
      const sel = snap.elements.find(e => e.kind === 'select');
      assert.ok(sel, 'select element must be found');
      assert.equal(sel.label, 'Dropdown (select)');
      assert.equal(sel.accessibleName, 'Dropdown (select)');
      assert.ok(!sel.accessibleName.includes('Open this select menu'));
      assert.ok(!sel.accessibleName.includes('One'));
      assert.ok(!sel.accessibleName.includes('Two'));
      assert.ok(!sel.accessibleName.includes('Three'));
      assert.ok(!sel.label.includes('Open this select menu'));
      assert.ok(!sel.label.includes('One'));
      assert.ok(!sel.label.includes('Two'));
      assert.ok(!sel.label.includes('Three'));
      assert.equal(sel.selectedText, 'Open this select menu');
    });

    test('preserves multilingual Unicode text for enclosing <label> without option contamination', () => {
      const arabicHtml = `
        <label>
          اختر لغة
          <select name="lang">
            <option selected>العربية</option>
            <option value="en">الإنجليزية</option>
          </select>
        </label>
      `;
      const arSnap = inspectHtmlString(arabicHtml);
      const arSel = arSnap.elements.find(e => e.kind === 'select');
      assert.ok(arSel);
      assert.equal(arSel.label, 'اختر لغة');
      assert.equal(arSel.accessibleName, 'اختر لغة');
      assert.equal(arSel.selectedText, 'العربية');
      assert.ok(!arSel.label.includes('العربية'));
      assert.ok(!arSel.accessibleName.includes('العربية'));

      const urduHtml = `
        <label>
          شہر منتخب کریں
          <select name="city">
            <option selected>لاہور</option>
            <option value="khi">کراچی</option>
          </select>
        </label>
      `;
      const urSnap = inspectHtmlString(urduHtml);
      const urSel = urSnap.elements.find(e => e.kind === 'select');
      assert.ok(urSel);
      assert.equal(urSel.label, 'شہر منتخب کریں');
      assert.equal(urSel.accessibleName, 'شہر منتخب کریں');
      assert.equal(urSel.selectedText, 'لاہور');

      const jaHtml = `
        <label>
          言語選択
          <select name="ja-lang">
            <option selected>日本語</option>
            <option value="en">英語</option>
          </select>
        </label>
      `;
      const jaSnap = inspectHtmlString(jaHtml);
      const jaSel = jaSnap.elements.find(e => e.kind === 'select');
      assert.ok(jaSel);
      assert.equal(jaSel.label, '言語選択');
      assert.equal(jaSel.accessibleName, '言語選択');
      assert.equal(jaSel.selectedText, '日本語');
    });
  });
});

