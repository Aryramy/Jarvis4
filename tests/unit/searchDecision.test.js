import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideSearchRoute, normalizeText } from '../../src/routing/searchDecision.js';
import {
  isFreshnessSensitiveQuery,
  URDU_FRESHNESS_SIGNALS,
  ARABIC_FRESHNESS_SIGNALS,
  ENGLISH_FRESHNESS_SIGNALS
} from '../../src/routing/freshnessSignals.js';

describe('Local Deterministic Search Decision Classifier - Unit Tests (Brick 20)', () => {
  // 1. "What is Power BI?" → ai
  test('1. "What is Power BI?" routes to normal ai', () => {
    const result = decideSearchRoute('What is Power BI?');
    assert.equal(result.route, 'ai');
    assert.equal(result.reason, 'default:no-live-signal');
    assert.equal(result.matchedRule, null);
  });

  // 2. "Explain star schema." → ai
  test('2. "Explain star schema." routes to normal ai', () => {
    const result = decideSearchRoute('Explain star schema.');
    assert.equal(result.route, 'ai');
    assert.equal(result.reason, 'default:no-live-signal');
    assert.equal(result.matchedRule, null);
  });

  // 3. "What are the latest Microsoft Fabric announcements?" → search
  test('3. "What are the latest Microsoft Fabric announcements?" routes to search', () => {
    const result = decideSearchRoute('What are the latest Microsoft Fabric announcements?');
    assert.equal(result.route, 'search');
    assert.match(result.reason, /latest/);
  });

  // 4. "What happened in AI news today?" → search
  test('4. "What happened in AI news today?" routes to search', () => {
    const result = decideSearchRoute('What happened in AI news today?');
    assert.equal(result.route, 'search');
    assert.ok(result.reason.includes('today') || result.reason.includes('news'));
  });

  // 5. "Who is the current CEO of Microsoft?" → search
  test('5. "Who is the current CEO of Microsoft?" routes to search', () => {
    const result = decideSearchRoute('Who is the current CEO of Microsoft?');
    assert.equal(result.route, 'search');
    assert.equal(result.reason, 'current:ceo');
    assert.equal(result.matchedRule, 'current:ceo');
  });

  // 6. "What is electric current?" → ai
  test('6. "What is electric current?" routes to normal ai', () => {
    const result = decideSearchRoute('What is electric current?');
    assert.equal(result.route, 'ai');
    assert.equal(result.reason, 'guard:explanation');
  });

  // 7. "How do I update Power BI Desktop?" → ai
  test('7. "How do I update Power BI Desktop?" routes to normal ai', () => {
    const result = decideSearchRoute('How do I update Power BI Desktop?');
    assert.equal(result.route, 'ai');
    assert.equal(result.reason, 'guard:explanation');
  });

  // 8. "Explain software release management." → ai
  test('8. "Explain software release management." routes to normal ai', () => {
    const result = decideSearchRoute('Explain software release management.');
    assert.equal(result.route, 'ai');
    assert.equal(result.reason, 'guard:explanation');
  });

  // 9. "What is the weather in Doha?" → search
  test('9. "What is the weather in Doha?" routes to search', () => {
    const result = decideSearchRoute('What is the weather in Doha?');
    assert.equal(result.route, 'search');
    assert.equal(result.reason, 'live:weather');
    assert.equal(result.matchedRule, 'live:weather');
  });

  // 10. "Explain how weather forecasting works." → ai
  test('10. "Explain how weather forecasting works." routes to normal ai', () => {
    const result = decideSearchRoute('Explain how weather forecasting works.');
    assert.equal(result.route, 'ai');
    assert.equal(result.reason, 'guard:explanation');
  });

  // 11. "What is the Bitcoin price?" → search
  test('11. "What is the Bitcoin price?" routes to search', () => {
    const result = decideSearchRoute('What is the Bitcoin price?');
    assert.equal(result.route, 'search');
    assert.equal(result.reason, 'live:crypto-price');
  });

  // 12. "Explain how Bitcoin pricing works." → ai
  test('12. "Explain how Bitcoin pricing works." routes to normal ai', () => {
    const result = decideSearchRoute('Explain how Bitcoin pricing works.');
    assert.equal(result.route, 'ai');
    assert.equal(result.reason, 'guard:explanation');
  });

  // 13. "What is the current USD to QAR rate?" → search
  test('13. "What is the current USD to QAR rate?" routes to search', () => {
    const result = decideSearchRoute('What is the current USD to QAR rate?');
    assert.equal(result.route, 'search');
    assert.ok(result.reason === 'current:rate' || result.reason === 'live:exchange-rate');
  });

  // 14. "What does recent mean?" → ai
  test('14. "What does recent mean?" routes to normal ai', () => {
    const result = decideSearchRoute('What does recent mean?');
    assert.equal(result.route, 'ai');
    assert.equal(result.reason, 'guard:definition');
  });

  // 15. "Define current." → ai
  test('15. "Define current." routes to normal ai', () => {
    const result = decideSearchRoute('Define current.');
    assert.equal(result.route, 'ai');
    assert.equal(result.reason, 'guard:definition');
  });

  // 16. "Meaning of latest." → ai
  test('16. "Meaning of latest." routes to normal ai', () => {
    const result = decideSearchRoute('Meaning of latest.');
    assert.equal(result.route, 'ai');
    assert.equal(result.reason, 'guard:definition');
  });

  // 17. "آج Microsoft Fabric کی تازہ ترین خبریں کیا ہیں؟" → search
  test('17. "آج Microsoft Fabric کی تازہ ترین خبریں کیا ہیں؟" routes to search', () => {
    const result = decideSearchRoute('آج Microsoft Fabric کی تازہ ترین خبریں کیا ہیں؟');
    assert.equal(result.route, 'search');
    assert.match(result.reason, /^multilingual:urdu:/);
  });

  // 18. "Power BI کیا ہے؟" → ai
  test('18. "Power BI کیا ہے؟" routes to normal ai', () => {
    const result = decideSearchRoute('Power BI کیا ہے؟');
    assert.equal(result.route, 'ai');
    assert.equal(result.reason, 'default:no-live-signal');
  });

  // 19. "ما هي أحدث أخبار Microsoft Fabric اليوم؟" → search
  test('19. "ما هي أحدث أخبار Microsoft Fabric اليوم؟" routes to search', () => {
    const result = decideSearchRoute('ما هي أحدث أخبار Microsoft Fabric اليوم؟');
    assert.equal(result.route, 'search');
    assert.match(result.reason, /^multilingual:arabic:/);
  });

  // 20. "ما هو Power BI؟" → ai
  test('20. "ما هو Power BI؟" routes to normal ai', () => {
    const result = decideSearchRoute('ما هو Power BI؟');
    assert.equal(result.route, 'ai');
    assert.equal(result.reason, 'default:no-live-signal');
  });

  // 21. matching is case-insensitive for English
  test('21. matching is case-insensitive for English', () => {
    const upper = decideSearchRoute('WHAT ARE THE LATEST MICROSOFT FABRIC ANNOUNCEMENTS?');
    assert.equal(upper.route, 'search');
    assert.match(upper.reason, /latest/);

    const mixed = decideSearchRoute('Who is the Current CEO of Microsoft?');
    assert.equal(mixed.route, 'search');
    assert.equal(mixed.reason, 'current:ceo');
  });

  // 22. leading/trailing whitespace does not alter classification
  test('22. leading/trailing whitespace does not alter classification', () => {
    const paddedSearch = decideSearchRoute('   \t\n What are the latest Microsoft Fabric announcements? \n  ');
    assert.equal(paddedSearch.route, 'search');

    const paddedAi = decideSearchRoute('   \t\n What is Power BI? \n  ');
    assert.equal(paddedAi.route, 'ai');
  });

  // 23. multiple spaces do not alter classification
  test('23. multiple spaces do not alter classification', () => {
    const spaced = decideSearchRoute('What    are    the    latest    Microsoft    Fabric    announcements?');
    assert.equal(spaced.route, 'search');
    assert.match(spaced.reason, /latest/);

    const spacedCurrent = decideSearchRoute('Who   is   the   current   CEO   of   Microsoft?');
    assert.equal(spacedCurrent.route, 'search');
    assert.equal(spacedCurrent.reason, 'current:ceo');
  });

  // 24. original provider query remains unchanged
  test('24. original provider query remains unchanged', () => {
    const originalQuery = '  What are the latest Microsoft Fabric announcements?  ';
    const copy = originalQuery.slice();
    decideSearchRoute(originalQuery);
    assert.equal(originalQuery, copy);
  });

  // 25. classifier performs zero network calls
  test('25. classifier performs zero network calls and is strictly synchronous', () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = () => {
      fetchCalled = true;
      throw new Error('fetch should not be called');
    };

    try {
      const result = decideSearchRoute('What are the latest announcements?');
      assert.equal(result.route, 'search');
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Additional false-positive & guard tests
  test('additional false-positive guards: definition queries with quotes', () => {
    const q1 = decideSearchRoute("What does 'recent' mean?");
    assert.equal(q1.route, 'ai');
    assert.equal(q1.reason, 'guard:definition');

    const q2 = decideSearchRoute('Meaning of latest.');
    assert.equal(q2.route, 'ai');
    assert.equal(q2.reason, 'guard:definition');

    const q3 = decideSearchRoute('What is the meaning of "news"?');
    assert.equal(q3.route, 'ai');
    assert.equal(q3.reason, 'guard:definition');
  });

  test('additional false-positive guards: conceptual explanations', () => {
    const q1 = decideSearchRoute('How does a stock price work?');
    assert.equal(q1.route, 'ai');
    assert.equal(q1.reason, 'guard:explanation');

    const q2 = decideSearchRoute('How does journalism work?');
    assert.equal(q2.route, 'ai');
    assert.equal(q2.reason, 'guard:explanation');

    const q3 = decideSearchRoute('Explain weather forecasting.');
    assert.equal(q3.route, 'ai');
    assert.equal(q3.reason, 'guard:explanation');

    const q4 = decideSearchRoute('What is a news article?');
    assert.equal(q4.route, 'ai');
    assert.equal(q4.reason, 'guard:explanation');

    const q5 = decideSearchRoute('What is version control?');
    assert.equal(q5.route, 'ai');
    assert.equal(q5.reason, 'default:no-live-signal');
  });

  test('live weather without city routes to search', () => {
    const q = decideSearchRoute('What is the weather?');
    assert.equal(q.route, 'search');
    assert.equal(q.reason, 'live:weather');
  });

  test('invalid and empty inputs route safely to ai default', () => {
    assert.equal(decideSearchRoute(null).route, 'ai');
    assert.equal(decideSearchRoute(undefined).route, 'ai');
    assert.equal(decideSearchRoute(123).route, 'ai');
    assert.equal(decideSearchRoute('').route, 'ai');
    assert.equal(decideSearchRoute('   \t\n  ').route, 'ai');
  });

  test('Shared freshness consistency: Urdu, Arabic, English routing & search layers agree', () => {
    // 1. Urdu latest/today query
    const urduQuery = 'آج Microsoft Fabric کی تازہ ترین خبریں کیا ہیں؟';
    const urduRoute = decideSearchRoute(urduQuery);
    assert.equal(urduRoute.route, 'search');
    assert.equal(isFreshnessSensitiveQuery(urduQuery), true);

    // 2. Arabic latest/today query
    const arabicQuery = 'ما هي أحدث أخبار Microsoft Fabric اليوم؟';
    const arabicRoute = decideSearchRoute(arabicQuery);
    assert.equal(arabicRoute.route, 'search');
    assert.equal(isFreshnessSensitiveQuery(arabicQuery), true);

    // 3. English latest query
    const englishQuery = 'What are the latest announcements?';
    const englishRoute = decideSearchRoute(englishQuery);
    assert.equal(englishRoute.route, 'search');
    assert.equal(isFreshnessSensitiveQuery(englishQuery), true);

    // 4. Urdu ordinary query
    const urduOrdinary = 'Power BI کیا ہے؟';
    const urduOrdRoute = decideSearchRoute(urduOrdinary);
    assert.equal(urduOrdRoute.route, 'ai');
    assert.equal(isFreshnessSensitiveQuery(urduOrdinary), false);

    // 5. Arabic ordinary query
    const arabicOrdinary = 'ما هو Power BI؟';
    const arabicOrdRoute = decideSearchRoute(arabicOrdinary);
    assert.equal(arabicOrdRoute.route, 'ai');
    assert.equal(isFreshnessSensitiveQuery(arabicOrdinary), false);

    // 6. English ordinary query
    const englishOrdinary = 'What is Power BI?';
    const englishOrdRoute = decideSearchRoute(englishOrdinary);
    assert.equal(englishOrdRoute.route, 'ai');
    assert.equal(isFreshnessSensitiveQuery(englishOrdinary), false);

    // 7. False-positive guards stay intact in both router and search
    assert.equal(decideSearchRoute('What is electric current?').route, 'ai');
    assert.equal(isFreshnessSensitiveQuery('What is electric current?'), false);

    assert.equal(decideSearchRoute('What does recent mean?').route, 'ai');
    assert.equal(isFreshnessSensitiveQuery('What does recent mean?'), false);

    assert.equal(decideSearchRoute('Define current.').route, 'ai');
    assert.equal(isFreshnessSensitiveQuery('Define current.'), false);
  });

  test('Shared freshness definitions verify all authorized signals', () => {
    // All 8 authorized Urdu signals trigger freshness
    for (const signal of URDU_FRESHNESS_SIGNALS) {
      assert.equal(isFreshnessSensitiveQuery(`سوال ${signal} معلومات`), true, `Urdu signal ${signal} should be recognized`);
    }

    // All 10 authorized Arabic signals trigger freshness
    for (const signal of ARABIC_FRESHNESS_SIGNALS) {
      assert.equal(isFreshnessSensitiveQuery(`سؤال ${signal} معلومات`), true, `Arabic signal ${signal} should be recognized`);
    }

    // All 14 authorized English signals trigger freshness
    for (const signal of ENGLISH_FRESHNESS_SIGNALS) {
      assert.equal(isFreshnessSensitiveQuery(`What are the ${signal} details?`), true, `English signal ${signal} should be recognized`);
    }
  });
});
