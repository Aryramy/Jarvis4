import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { extractFormsSnapshot, inspectFormsFromCheerio, FormInspectionError } from '../../src/browser/formInspector.js';

describe('Form Inspection Unit Tests (Brick 33)', () => {
  test('discovers single form and its attributes', () => {
    const html = `
      <form id="login-form" name="loginForm" action="/login" method="POST" aria-label="User Login">
        <label for="u">Username</label>
        <input type="text" id="u" name="username" required>
        <button type="submit">Log in</button>
      </form>
    `;
    const $ = cheerio.load(html);
    const result = inspectFormsFromCheerio($);

    assert.equal(result.totalFormsCount, 1);
    assert.equal(result.forms.length, 1);
    const form = result.forms[0];
    assert.equal(form.formId, 'form_0');
    assert.equal(form.id, 'login-form');
    assert.equal(form.name, 'loginForm');
    assert.equal(form.action, '/login');
    assert.equal(form.method, 'POST');
    assert.equal(form.accessibleName, 'User Login');
    assert.equal(form.fields.length, 1);
    assert.equal(form.fields[0].name, 'username');
    assert.equal(form.fields[0].required, true);
    assert.equal(form.buttons.length, 1);
    assert.equal(form.buttons[0].type, 'submit');
    assert.equal(form.buttons[0].text, 'Log in');
  });

  test('discovers multiple forms and classifies buttons correctly', () => {
    const html = `
      <form id="search-form" action="/search" method="GET">
        <input type="search" name="q" placeholder="Search products">
        <button type="submit">Search</button>
      </form>
      <form id="contact-form" action="/contact" method="POST">
        <label for="msg">Message</label>
        <textarea id="msg" name="message"></textarea>
        <button type="reset">Reset</button>
        <button type="button">Draft</button>
        <button type="submit">Send</button>
      </form>
    `;
    const $ = cheerio.load(html);
    const result = inspectFormsFromCheerio($);

    assert.equal(result.totalFormsCount, 2);
    assert.equal(result.forms[0].id, 'search-form');
    assert.equal(result.forms[0].buttons[0].type, 'submit');

    assert.equal(result.forms[1].id, 'contact-form');
    assert.equal(result.forms[1].buttons.length, 3);
    assert.equal(result.forms[1].buttons[0].type, 'reset');
    assert.equal(result.forms[1].buttons[1].type, 'button');
    assert.equal(result.forms[1].buttons[2].type, 'submit');
  });

  test('label resolution: label for=id, enclosing label, aria-label, aria-labelledby, placeholder fallback', () => {
    const html = `
      <form id="test-labels">
        <!-- 1. label for -->
        <label for="f1">First Name</label>
        <input type="text" id="f1" name="first_name">

        <!-- 2. enclosing label -->
        <label>
          Last Name
          <input type="text" name="last_name">
        </label>

        <!-- 3. aria-label -->
        <input type="email" name="email" aria-label="Direct Email Label">

        <!-- 4. aria-labelledby -->
        <span id="label-source">Company Phone</span>
        <input type="tel" name="phone" aria-labelledby="label-source">

        <!-- 5. placeholder fallback -->
        <input type="text" name="city" placeholder="City or Town">
      </form>
    `;
    const $ = cheerio.load(html);
    const result = inspectFormsFromCheerio($);
    const fields = result.forms[0].fields;

    assert.equal(fields[0].label, 'First Name');
    assert.equal(fields[1].label, 'Last Name');
    assert.equal(fields[2].accessibleName, 'Direct Email Label');
    assert.equal(fields[3].label, 'Company Phone');
    assert.equal(fields[4].label, 'City or Town');
    assert.equal(fields[4].placeholder, 'City or Town');
  });

  test('select control: extracts options and current selection without leakage', () => {
    const html = `
      <form id="f-select">
        <label for="co">Country</label>
        <select id="co" name="country">
          <option value="">Choose</option>
          <option value="qa" selected>Qatar</option>
          <option value="us">United States</option>
          <option value="uk" disabled>United Kingdom</option>
        </select>
      </form>
    `;
    const $ = cheerio.load(html);
    const result = inspectFormsFromCheerio($);
    const selectField = result.forms[0].fields[0];

    assert.equal(selectField.kind, 'select');
    assert.equal(selectField.name, 'country');
    assert.equal(selectField.label, 'Country');
    assert.equal(selectField.options.length, 4);
    assert.equal(selectField.options[1].label, 'Qatar');
    assert.equal(selectField.options[1].selected, true);
    assert.equal(selectField.options[3].disabled, true);
    assert.equal(selectField.selectedOption.label, 'Qatar');
  });

  test('checkbox and radio groups with fieldset legend', () => {
    const html = `
      <form id="f-checks">
        <label>
          <input type="checkbox" name="terms" checked> Accept Terms
        </label>
        <fieldset>
          <legend>Shipping Method</legend>
          <label><input type="radio" name="shipping" value="standard"> Standard</label>
          <label><input type="radio" name="shipping" value="express" checked> Express</label>
        </fieldset>
      </form>
    `;
    const $ = cheerio.load(html);
    const result = inspectFormsFromCheerio($);
    const form = result.forms[0];

    const checkbox = form.fields.find(f => f.type === 'checkbox');
    assert.equal(checkbox.checked, true);
    assert.equal(checkbox.label, 'Accept Terms');

    assert.equal(form.radioGroups.length, 1);
    const group = form.radioGroups[0];
    assert.equal(group.groupName, 'shipping');
    assert.equal(group.label, 'Shipping Method');
    assert.equal(group.options.length, 2);
    assert.equal(group.options[1].label, 'Express');
    assert.equal(group.options[1].checked, true);
  });

  test('strict privacy: password, hidden, and file inputs NEVER leak values', () => {
    const html = `
      <form id="f-sec">
        <input type="hidden" name="csrf" value="SUPER-SECRET-CSRF-TOKEN">
        <label for="p">Secret Password</label>
        <input type="password" id="p" name="pwd" value="P@ssw0rd123!">
        <label for="f">Upload Resume</label>
        <input type="file" id="f" name="resume" value="C:\\Users\\admin\\resume.pdf">
      </form>
    `;
    const $ = cheerio.load(html);
    const result = inspectFormsFromCheerio($);
    const fields = result.forms[0].fields;

    const hidden = fields.find(f => f.type === 'hidden');
    assert.equal(hidden.isHidden, true);
    assert.equal(hidden.value, undefined, 'Hidden input value MUST NOT be exposed');

    const pwd = fields.find(f => f.type === 'password');
    assert.equal(pwd.sensitive, true);
    assert.equal(pwd.value, undefined, 'Password value MUST NOT be exposed');

    const file = fields.find(f => f.type === 'file');
    assert.equal(file.isFile, true);
    assert.equal(file.value, undefined, 'File input value MUST NOT be exposed');

    // JSON serialization test: ensure no hidden secrets exist anywhere in the output
    const jsonStr = JSON.stringify(result);
    assert.equal(jsonStr.includes('SUPER-SECRET-CSRF-TOKEN'), false);
    assert.equal(jsonStr.includes('P@ssw0rd123!'), false);
    assert.equal(jsonStr.includes('resume.pdf'), false);
  });

  test('identifies disabled and readonly states', () => {
    const html = `
      <form id="f-state">
        <input type="text" name="locked" disabled value="Fixed">
        <input type="text" name="read" readonly value="Reference">
      </form>
    `;
    const $ = cheerio.load(html);
    const result = inspectFormsFromCheerio($);
    const fields = result.forms[0].fields;

    assert.equal(fields[0].disabled, true);
    assert.equal(fields[1].readonly, true);
  });

  test('formless unassociated controls outside any form are captured in unassociatedFields', () => {
    const html = `
      <div>
        <label for="search-box">Global Search</label>
        <input type="search" id="search-box" name="global_search">
      </div>
      <form id="my-form">
        <input type="text" name="inside">
      </form>
    `;
    const $ = cheerio.load(html);
    const result = inspectFormsFromCheerio($);

    assert.equal(result.forms.length, 1);
    assert.equal(result.forms[0].fields.length, 1);
    assert.equal(result.unassociatedFields.length, 1);
    assert.equal(result.unassociatedFields[0].name, 'global_search');
    assert.equal(result.unassociatedFields[0].label, 'Global Search');
  });

  test('Unicode & multilingual labels (Urdu, Arabic) are accurately preserved', () => {
    const html = `
      <form id="multilingual">
        <label for="u-name">نام</label>
        <input type="text" id="u-name" name="name_ur">
        <label for="ar-email">البريد الإلكتروني</label>
        <input type="email" id="ar-email" name="email_ar">
      </form>
    `;
    const $ = cheerio.load(html);
    const result = inspectFormsFromCheerio($);
    const fields = result.forms[0].fields;

    assert.equal(fields[0].label, 'نام');
    assert.equal(fields[1].label, 'البريد الإلكتروني');
  });

  test('covers diverse input kinds: tel, url, number, and textarea', () => {
    const html = `
      <form id="diverse-types">
        <label for="f-tel">Phone</label>
        <input type="tel" id="f-tel" name="phone">
        <label for="f-url">Website</label>
        <input type="url" id="f-url" name="website">
        <label for="f-num">Quantity</label>
        <input type="number" id="f-num" name="quantity" min="1" max="100">
        <label for="f-notes">Notes</label>
        <textarea id="f-notes" name="notes" placeholder="Additional notes"></textarea>
      </form>
    `;
    const $ = cheerio.load(html);
    const result = inspectFormsFromCheerio($);
    const fields = result.forms[0].fields;

    const tel = fields.find(f => f.kind === 'tel');
    assert.ok(tel);
    assert.equal(tel.label, 'Phone');

    const url = fields.find(f => f.kind === 'url');
    assert.ok(url);
    assert.equal(url.label, 'Website');

    const num = fields.find(f => f.kind === 'number');
    assert.ok(num);
    assert.equal(num.label, 'Quantity');

    const notes = fields.find(f => f.kind === 'textarea');
    assert.ok(notes);
    assert.equal(notes.label, 'Notes');
    assert.equal(notes.placeholder, 'Additional notes');
  });

  test('distinguishes required and optional fields', () => {
    const html = `
      <form id="req-opt">
        <label for="r1">Required Field</label>
        <input type="text" id="r1" name="req" required>
        <label for="o1">Optional Field</label>
        <input type="text" id="o1" name="opt">
      </form>
    `;
    const $ = cheerio.load(html);
    const result = inspectFormsFromCheerio($);
    const fields = result.forms[0].fields;

    assert.equal(fields[0].required, true);
    assert.equal(fields[1].required, undefined);
  });

  test('distinguishes button types submit, reset, and ordinary button', () => {
    const html = `
      <form id="btn-types">
        <button type="submit">Submit Button</button>
        <button type="reset">Reset Button</button>
        <button type="button">Ordinary Button</button>
        <input type="submit" value="Submit Input">
        <input type="reset" value="Reset Input">
      </form>
    `;
    const $ = cheerio.load(html);
    const result = inspectFormsFromCheerio($);
    const buttons = result.forms[0].buttons;

    assert.equal(buttons.length, 5);
    assert.equal(buttons[0].type, 'submit');
    assert.equal(buttons[1].type, 'reset');
    assert.equal(buttons[2].type, 'button');
    assert.equal(buttons[3].type, 'submit');
    assert.equal(buttons[4].type, 'reset');
  });
});
