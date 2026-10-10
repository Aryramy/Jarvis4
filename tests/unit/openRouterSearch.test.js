import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchProvider } from '../../src/providers/searchBase.js';
import {
  OpenRouterSearchProvider,
  buildSearchSystemPrompt,
  NARROW_SEARCH_SYSTEM_INSTRUCTION,
  PINNED_SEARCH_TOOL,
  isFreshnessSensitiveQuery,
  computeFreshnessMetadata,
  extractMessageText
} from '../../src/providers/openRouterSearch.js';

test('OpenRouter Search Provider - Brick 19 Unit Tests', async (t) => {
  await t.test('OpenRouterSearchProvider exists and inherits from SearchProvider', () => {
    const provider = new OpenRouterSearchProvider({ apiKey: 'test-key' });
    assert.ok(provider instanceof SearchProvider);
    assert.equal(provider.name, 'openrouter-search');
  });

  await t.test('uses correct default endpoint, model, engine: exa, mode: fast, max_uses: 1, and search tool limits', () => {
    const provider = new OpenRouterSearchProvider({ apiKey: 'test-key' });
    assert.equal(provider.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(provider.model, 'deepseek/deepseek-v4-flash-0731');
    assert.equal(provider.engine, 'exa');
    assert.equal(provider.mode, 'fast');
    assert.equal(provider.maxUses, 1);
    assert.equal(provider.maxResults, 3);
    assert.equal(provider.maxTotalResults, 3);
    assert.equal(provider.maxCharacters, 1200);
    assert.equal(provider.maxTokens, 1500);
    assert.equal(provider.maxToolCalls, undefined, 'top-level max_tool_calls must not be present on instance');
    assert.deepEqual(PINNED_SEARCH_TOOL, {
      type: 'openrouter:web_search',
      parameters: {
        engine: 'exa',
        mode: 'fast',
        max_uses: 1,
        max_results: 3,
        max_total_results: 3,
        max_characters: 1200
      }
    });
  });

  await t.test('validateConfig rejects missing or invalid apiKey and model', () => {
    const p1 = new OpenRouterSearchProvider({ apiKey: '' });
    assert.equal(p1.validateConfig().valid, false);

    const p2 = new OpenRouterSearchProvider({ apiKey: 'valid-key', model: '' });
    assert.equal(p2.validateConfig().valid, false);

    const p3 = new OpenRouterSearchProvider({ apiKey: 'valid-key', model: 'deepseek/deepseek-v4-flash-0731' });
    assert.equal(p3.validateConfig().valid, true);
  });

  await t.test('rejects empty or non-string prompt without network call', async () => {
    let fetchCalled = false;
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async () => {
        fetchCalled = true;
        return new Response('{}');
      }
    });

    const res1 = await provider.search('');
    assert.equal(res1.success, false);
    assert.equal(res1.searchUsed, false);
    assert.equal(res1.searchRequests, null);
    assert.equal(res1.searchEvidence, 'none');
    assert.deepEqual(res1.sources, []);
    assert.equal(fetchCalled, false);

    const res2 = await provider.search('   ');
    assert.equal(res2.success, false);
    assert.equal(res2.searchRequests, null);
    assert.equal(fetchCalled, false);

    const res3 = await provider.search(null);
    assert.equal(res3.success, false);
    assert.equal(res3.searchRequests, null);
    assert.equal(fetchCalled, false);
  });

  await t.test('1-8. sends request with search-specific max_uses: 1, engine exa, mode fast, max_tokens: 1500, and NO top-level max_tool_calls', async () => {
    let capturedUrl = '';
    let capturedOptions = {};

    const mockResponse = {
      model: 'deepseek/deepseek-v4-flash-0731',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Microsoft Fabric announced real-time intelligence.',
            annotations: [
              {
                type: 'url_citation',
                url_citation: {
                  url: 'https://blog.fabric.microsoft.com/news',
                  title: 'Microsoft Fabric Blog',
                  published_date: '2026-10-05'
                }
              }
            ]
          }
        }
      ],
      usage: {
        server_tool_use: {
          web_search_requests: 1
        }
      }
    };

    const provider = new OpenRouterSearchProvider({
      apiKey: 'sk-secret-test-key-12345',
      fetchFn: async (url, opts) => {
        capturedUrl = url;
        capturedOptions = opts;
        return new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    });

    const result = await provider.search('What are the latest Microsoft Fabric announcements?');

    assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(capturedOptions.method, 'POST');
    assert.equal(capturedOptions.headers['Authorization'], 'Bearer sk-secret-test-key-12345');
    assert.equal(capturedOptions.headers['Content-Type'], 'application/json');

    const body = JSON.parse(capturedOptions.body);
    assert.equal(body.model, 'deepseek/deepseek-v4-flash-0731');

    // 1. Top-level max_tool_calls REMOVED
    assert.equal(body.max_tool_calls, undefined, 'top-level max_tool_calls must be removed');

    // 8. Output token limit target (max_tokens: 1500)
    assert.equal(body.max_tokens, 1500);

    // Messages assertion
    assert.equal(body.messages.length, 2);
    assert.equal(body.messages[0].role, 'system');
    assert.ok(body.messages[0].content.includes('Current date:'));
    assert.equal(body.messages[1].role, 'user');
    assert.equal(body.messages[1].content, 'What are the latest Microsoft Fabric announcements?');

    // 2, 3, 4, 5, 6, 7. Search parameters
    assert.ok(Array.isArray(body.tools));
    assert.equal(body.tools.length, 1);
    assert.equal(body.tools[0].type, 'openrouter:web_search');
    assert.equal(body.tools[0].parameters.engine, 'exa');
    assert.equal(body.tools[0].parameters.mode, 'fast');
    assert.equal(body.tools[0].parameters.max_uses, 1);
    assert.equal(body.tools[0].parameters.max_results, 3);
    assert.equal(body.tools[0].parameters.max_total_results, 3);
    assert.equal(body.tools[0].parameters.max_characters, 1200);

    // Result verification & safe diagnostics
    assert.equal(result.success, true);
    assert.equal(result.provider, 'openrouter');
    assert.equal(result.model, 'deepseek/deepseek-v4-flash-0731');
    assert.equal(result.response, 'Microsoft Fabric announced real-time intelligence.');
    assert.equal(result.searchUsed, true);
    assert.equal(result.searchRequests, 1);
    assert.equal(result.providerFinishReason, 'stop');
    assert.equal(result.hasMessage, true);
    assert.equal(result.hasMessageContent, true);
    assert.equal(result.contentType, 'string');
    assert.equal(result.hasToolCalls, false);
    assert.equal(result.hasReasoning, false);
    assert.equal(result.annotationCount, 1);
    assert.deepEqual(result.sources, [
      {
        title: 'Microsoft Fabric Blog',
        url: 'https://blog.fabric.microsoft.com/news',
        publishedDate: '2026-10-05'
      }
    ]);
  });

  await t.test('10 & 11. extracts string and supported structured text content', () => {
    // 10. String content
    assert.equal(extractMessageText('Simple text answer'), 'Simple text answer');
    assert.equal(extractMessageText('   Trimmed text   '), 'Trimmed text');

    // 11. Structured array content
    const structuredContent = [
      { type: 'text', text: 'First part of answer. ' },
      { type: 'text', text: 'Second part of answer.' }
    ];
    assert.equal(extractMessageText(structuredContent), 'First part of answer. Second part of answer.');

    // Empty / null / invalid
    assert.equal(extractMessageText(null), '');
    assert.equal(extractMessageText(undefined), '');
    assert.equal(extractMessageText([]), '');
    assert.equal(extractMessageText(''), '');
  });

  await t.test('11 integration: extracts structured text content from provider response', async () => {
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async () => {
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: [
                  { type: 'text', text: 'Synthesized answer from web search.' }
                ],
                annotations: [{ type: 'url_citation', url_citation: { url: 'https://src.com', title: 'Source' } }]
              }
            }
          ],
          usage: { server_tool_use: { web_search_requests: 1 } }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const res = await provider.search('Query');
    assert.equal(res.success, true);
    assert.equal(res.response, 'Synthesized answer from web search.');
    assert.equal(res.contentType, 'array');
    assert.equal(res.hasMessageContent, true);
  });

  await t.test('12. null content + finish_reason length -> SEARCH_OUTPUT_TRUNCATED', async () => {
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async () => {
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: 'length',
              message: {
                role: 'assistant',
                content: null,
                annotations: [{ type: 'url_citation', url_citation: { url: 'https://src.com', title: 'Src' } }]
              }
            }
          ],
          usage: { server_tool_use: { web_search_requests: 1 } }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const res = await provider.search('Query');
    assert.equal(res.success, false);
    assert.equal(res.error, 'SEARCH_OUTPUT_TRUNCATED');
    assert.equal(res.providerFinishReason, 'length');
    assert.equal(res.hasMessageContent, false);
    // 20. Search evidence remains preserved on controlled error
    assert.equal(res.searchUsed, true);
    assert.equal(res.searchRequests, 1);
    assert.equal(res.searchEvidence, 'usage+url_citation');
    assert.equal(res.sources.length, 1);
    // 21. Citations alone do NOT become fabricated answer
    assert.equal(res.response, undefined);
    assert.equal(res.text, undefined);
  });

  await t.test('13. null content + unresolved tool_calls -> SEARCH_TOOL_LOOP_INCOMPLETE', async () => {
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async () => {
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_123',
                    type: 'function',
                    function: { name: 'search', arguments: '{}' }
                  }
                ],
                annotations: [{ type: 'url_citation', url_citation: { url: 'https://src.com', title: 'Src' } }]
              }
            }
          ],
          usage: { server_tool_use: { web_search_requests: 1 } }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const res = await provider.search('Query');
    assert.equal(res.success, false);
    assert.equal(res.error, 'SEARCH_TOOL_LOOP_INCOMPLETE');
    assert.equal(res.providerFinishReason, 'tool_calls');
    assert.equal(res.hasToolCalls, true);
    assert.equal(res.hasMessageContent, false);
    // 20. Evidence preserved
    assert.equal(res.searchUsed, true);
    assert.equal(res.searchRequests, 1);
    assert.equal(res.sources.length, 1);
    // 21. Citations alone do NOT become fabricated answer
    assert.equal(res.response, undefined);
  });

  await t.test('14. null content without usable final answer -> SEARCH_PROVIDER_NO_FINAL_CONTENT', async () => {
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async () => {
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: null,
                annotations: [{ type: 'url_citation', url_citation: { url: 'https://src.com', title: 'Src' } }]
              }
            }
          ],
          usage: { server_tool_use: { web_search_requests: 1 } }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const res = await provider.search('Query');
    assert.equal(res.success, false);
    assert.equal(res.error, 'SEARCH_PROVIDER_NO_FINAL_CONTENT');
    assert.equal(res.providerFinishReason, 'stop');
    assert.equal(res.hasMessageContent, false);
    assert.equal(res.searchUsed, true);
    assert.equal(res.sources.length, 1);
    assert.equal(res.response, undefined);
  });

  await t.test('17, 18, 19. safe diagnostics do NOT expose raw response, reasoning text, or secret API key', async () => {
    const secretKey = 'sk-or-v1-my-very-secret-token';
    const provider = new OpenRouterSearchProvider({
      apiKey: secretKey,
      fetchFn: async () => {
        return new Response(JSON.stringify({
          id: 'gen-12345',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Public synthesized response.',
                reasoning: 'Secret internal reasoning that must not leak to user',
                reasoning_content: 'Hidden thought process'
              }
            }
          ]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const res = await provider.search('Query');
    assert.equal(res.success, true);
    assert.equal(res.response, 'Public synthesized response.');
    assert.equal(res.hasReasoning, true);
    // Never expose raw response or hidden reasoning text
    assert.equal(res.raw, undefined);
    assert.equal(res.rawResponse, undefined);
    assert.equal(res.reasoning, undefined);
    assert.equal(res.reasoning_content, undefined);
    // Never expose secret key
    const jsonStr = JSON.stringify(res);
    assert.ok(!jsonStr.includes(secretKey));
  });

  await t.test('6 & 7. current date is generated dynamically and is not hard-coded to 2026-10-10', async () => {
    let capturedPrompt = '';
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async (url, opts) => {
        const body = JSON.parse(opts.body);
        capturedPrompt = body.messages[0].content;
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Reply.' } }]
        }));
      }
    });

    // Test with simulated future date
    await provider.search('query', { currentDate: '2030-01-15' });
    assert.ok(capturedPrompt.includes('Current date: 2030-01-15.'));
    assert.ok(!capturedPrompt.includes('2026-10-10'));

    // Test with simulated past date
    await provider.search('query', { currentDate: '2024-05-20' });
    assert.ok(capturedPrompt.includes('Current date: 2024-05-20.'));

    // Test default dynamically generates current UTC date
    await provider.search('query');
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(capturedPrompt.includes(`Current date: ${today}.`));
  });

  await t.test('8 & 9. freshness-sensitive query detection works and does not false-positive on ordinary queries', () => {
    assert.equal(isFreshnessSensitiveQuery('What are the latest announcements?'), true);
    assert.equal(isFreshnessSensitiveQuery('Tell me recent news about AI'), true);
    assert.equal(isFreshnessSensitiveQuery('What is the current stock price?'), true);
    assert.equal(isFreshnessSensitiveQuery('What happened today in technology?'), true);
    assert.equal(isFreshnessSensitiveQuery('Summarize releases this week'), true);
    assert.equal(isFreshnessSensitiveQuery('Key events this month'), true);
    assert.equal(isFreshnessSensitiveQuery('What is the newest smartphone?'), true);
    assert.equal(isFreshnessSensitiveQuery('What was recently announced by OpenAI?'), true);

    assert.equal(isFreshnessSensitiveQuery('What is the capital of France?'), false);
    assert.equal(isFreshnessSensitiveQuery('Explain the quicksort algorithm in Python'), false);
    assert.equal(isFreshnessSensitiveQuery('How does cellular respiration work?'), false);
    assert.equal(isFreshnessSensitiveQuery('Write a poem about the sea'), false);
  });

  await t.test('system instruction instructs model not to call old results latest and states newest publication date', () => {
    const prompt = buildSearchSystemPrompt('2026-10-10');
    assert.ok(prompt.includes('Current date: 2026-10-10.'));
    assert.ok(prompt.includes('do not describe older results as "latest" if newer evidence was not found'));
    assert.ok(prompt.includes('explicitly state the newest publication date actually found'));
    assert.ok(prompt.includes('The newest search result I found is dated <date>. I did not find a newer result in this search.'));
    assert.ok(prompt.includes('Provide a concise answer with approximately 3-5 useful bullet points and a brief summary.'));
    assert.ok(prompt.includes('Maximum 3 primary sources when possible.'));
    assert.ok(prompt.includes('Avoid unnecessary background history.'));
    assert.ok(prompt.includes('Do not repeat the list of source URLs inside the narrative prose.'));
  });

  await t.test('source publication date preserved when provider supplies it and never fabricated', () => {
    const provider = new OpenRouterSearchProvider({ apiKey: 'test-key' });

    const dataWithDate = {
      choices: [{
        message: {
          role: 'assistant',
          content: 'text',
          annotations: [
            {
              type: 'url_citation',
              url_citation: {
                url: 'https://example.com/a',
                title: 'Example A',
                published_date: '2026-10-01'
              }
            }
          ]
        }
      }]
    };

    const sourcesWithDate = provider.extractSources(dataWithDate);
    assert.equal(sourcesWithDate.length, 1);
    assert.equal(sourcesWithDate[0].publishedDate, '2026-10-01');

    const dataWithoutDate = {
      choices: [{
        message: {
          role: 'assistant',
          content: 'text with 2026-10-10 in prose',
          annotations: [
            {
              type: 'url_citation',
              url_citation: {
                url: 'https://example.com/b',
                title: 'Example B'
              }
            }
          ]
        }
      }]
    };

    const sourcesWithoutDate = provider.extractSources(dataWithoutDate);
    assert.equal(sourcesWithoutDate.length, 1);
    assert.equal(sourcesWithoutDate[0].publishedDate, null);
  });

  await t.test('newestSourceDate and freshnessStatus calculation', () => {
    const currentDate = '2026-10-10';

    const recentSources = [
      { title: 'Doc 1', url: 'https://a.com', publishedDate: '2026-08-01' },
      { title: 'Doc 2', url: 'https://b.com', publishedDate: '2026-10-02' }
    ];
    const metaRecent = computeFreshnessMetadata('latest updates', recentSources, currentDate);
    assert.equal(metaRecent.freshnessSensitive, true);
    assert.equal(metaRecent.newestSourceDate, '2026-10-02');
    assert.equal(metaRecent.freshnessStatus, 'current');

    const oldSources = [
      { title: 'Old 1', url: 'https://old1.com', publishedDate: '2024-11-01' },
      { title: 'Old 2', url: 'https://old2.com', publishedDate: '2025-05-15' }
    ];
    const metaOld = computeFreshnessMetadata('latest news', oldSources, currentDate);
    assert.equal(metaOld.freshnessSensitive, true);
    assert.equal(metaOld.newestSourceDate, '2025-05-15');
    assert.equal(metaOld.freshnessStatus, 'older-results-only');

    const undatedSources = [
      { title: 'No Date 1', url: 'https://c.com', publishedDate: null },
      { title: 'No Date 2', url: 'https://d.com', publishedDate: null }
    ];
    const metaUndated = computeFreshnessMetadata('latest news', undatedSources, currentDate);
    assert.equal(metaUndated.freshnessSensitive, true);
    assert.equal(metaUndated.newestSourceDate, null);
    assert.equal(metaUndated.freshnessStatus, 'unknown');
  });

  await t.test('30-second timeout remains controlled and does not reuse previous results or fall back', async () => {
    let callCount = 0;
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      timeoutMs: 30000,
      fetchFn: async (url, { signal }) => {
        callCount++;
        if (callCount === 1) {
          return new Response(JSON.stringify({
            choices: [{
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'First valid answer',
                annotations: [{ type: 'url_citation', url_citation: { url: 'https://first.com', title: 'First' } }]
              }
            }],
            usage: { server_tool_use: { web_search_requests: 1 } }
          }));
        }

        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
          setTimeout(() => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          }, 10);
        });
      }
    });

    const first = await provider.search('First call');
    assert.equal(first.success, true);
    assert.equal(first.response, 'First valid answer');
    assert.equal(first.sources.length, 1);

    const timedOut = await provider.search('Second call', { timeoutMs: 10 });
    assert.equal(timedOut.success, false);
    assert.ok(timedOut.error.includes('Request timed out after 10ms'));
    assert.equal(timedOut.response, undefined);
    assert.equal(timedOut.text, undefined);
    assert.deepEqual(timedOut.sources, []);
    assert.equal(timedOut.searchUsed, false);
    assert.equal(timedOut.searchRequests, null);
    assert.equal(timedOut.searchEvidence, 'none');
  });

  await t.test('usage count 1 + citations produces searchUsed true, searchRequests 1, searchEvidence usage+url_citation', async () => {
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async () => {
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Grounded reply.',
              annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/a', title: 'Example A' } }]
            }
          }],
          usage: { server_tool_use: { web_search_requests: 1 } }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const res = await provider.search('Query');
    assert.equal(res.success, true);
    assert.equal(res.searchUsed, true);
    assert.equal(res.searchRequests, 1);
    assert.equal(res.searchEvidence, 'usage+url_citation');
    assert.equal(res.sources.length, 1);
  });

  await t.test('usage count 2 without citations produces searchUsed true, searchRequests 2, searchEvidence usage', async () => {
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async () => {
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Grounded reply.' } }],
          usage: { server_tool_use: { web_search_requests: 2 } }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const res = await provider.search('Query');
    assert.equal(res.success, true);
    assert.equal(res.searchUsed, true);
    assert.equal(res.searchRequests, 2);
    assert.equal(res.searchEvidence, 'usage');
    assert.deepEqual(res.sources, []);
  });

  await t.test('missing usage count + genuine url_citation annotations produces searchUsed true, searchRequests null, searchEvidence url_citation', async () => {
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async () => {
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Grounded reply from live search.',
              annotations: [{ type: 'url_citation', url_citation: { url: 'https://fabric.microsoft.com', title: 'Fabric' } }]
            }
          }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const res = await provider.search('Query');
    assert.equal(res.success, true);
    assert.equal(res.searchUsed, true);
    assert.equal(res.searchRequests, null);
    assert.equal(res.searchEvidence, 'url_citation');
    assert.equal(res.sources.length, 1);
  });

  await t.test('missing usage + no annotations produces searchUsed false, searchRequests null, searchEvidence none', async () => {
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async () => {
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Ungrounded reply.' } }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const res = await provider.search('Query');
    assert.equal(res.success, true);
    assert.equal(res.searchUsed, false);
    assert.equal(res.searchRequests, null);
    assert.equal(res.searchEvidence, 'none');
    assert.deepEqual(res.sources, []);
  });

  await t.test('explicit usage count 0 + no annotations produces searchUsed false, searchRequests 0, searchEvidence none', async () => {
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async () => {
        return new Response(JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Ungrounded reply.' } }],
          usage: { server_tool_use: { web_search_requests: 0 } }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const res = await provider.search('Query');
    assert.equal(res.success, true);
    assert.equal(res.searchUsed, false);
    assert.equal(res.searchRequests, 0);
    assert.equal(res.searchEvidence, 'none');
    assert.deepEqual(res.sources, []);
  });

  await t.test('URLs appearing only in assistant narrative text do NOT prove search use', async () => {
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async () => {
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Here is some information about Microsoft Fabric. Check https://fabric.microsoft.com and [Docs](https://learn.microsoft.com).'
            }
          }]
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const res = await provider.search('Tell me about Fabric');
    assert.equal(res.success, true);
    assert.equal(res.searchUsed, false);
    assert.equal(res.searchRequests, null);
    assert.equal(res.searchEvidence, 'none');
    assert.deepEqual(res.sources, []);
  });

  await t.test('fabricated model statement such as "Based on my web search" does NOT prove search use', async () => {
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async () => {
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'Based on my web search, the latest Microsoft Fabric announcement is real-time intelligence.'
            }
          }],
          usage: { server_tool_use: { web_search_requests: 0 } }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const res = await provider.search('What are the latest announcements?');
    assert.equal(res.success, true);
    assert.equal(res.searchUsed, false);
    assert.equal(res.searchRequests, 0);
    assert.equal(res.searchEvidence, 'none');
    assert.deepEqual(res.sources, []);
  });

  await t.test('extracts citations from annotations and flat formats, safely deduplicates URLs', async () => {
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async () => {
        return new Response(JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: 'Response text',
                annotations: [
                  {
                    type: 'url_citation',
                    url_citation: {
                      url: 'https://example.com/page1',
                      title: 'Page 1',
                      content: 'Excerpt 1',
                      published_date: '2026-10-02'
                    }
                  },
                  {
                    type: 'url_citation',
                    url: 'https://example.com/page2',
                    title: 'Page 2'
                  },
                  {
                    type: 'url_citation',
                    url_citation: {
                      url: 'https://example.com/page1',
                      title: 'Page 1 Duplicate'
                    }
                  }
                ]
              }
            }
          ],
          usage: { server_tool_use: { web_search_requests: 1 } }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const res = await provider.search('Query');
    assert.equal(res.success, true);
    assert.equal(res.sources.length, 2);
    assert.deepEqual(res.sources[0], {
      title: 'Page 1',
      url: 'https://example.com/page1',
      content: 'Excerpt 1',
      publishedDate: '2026-10-02'
    });
    assert.deepEqual(res.sources[1], {
      title: 'Page 2',
      url: 'https://example.com/page2',
      publishedDate: null
    });
  });

  await t.test('handles provider HTTP error safely and redacts secret API key', async () => {
    const secretKey = 'sk-or-v1-secret-to-never-leak';
    const provider = new OpenRouterSearchProvider({
      apiKey: secretKey,
      fetchFn: async () => {
        return new Response(JSON.stringify({
          error: { message: `Invalid key ${secretKey}` }
        }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const res = await provider.search('Query');
    assert.equal(res.success, false);
    assert.ok(res.error.includes('Provider HTTP 401'));
    assert.ok(!res.error.includes(secretKey));
    assert.ok(res.error.includes('[REDACTED]'));
    assert.equal(res.searchUsed, false);
    assert.equal(res.searchRequests, null);
    assert.equal(res.searchEvidence, 'none');
    assert.deepEqual(res.sources, []);
    assert.equal(typeof res.providerSearchDurationMs, 'number');
  });

  await t.test('handles malformed JSON from provider cleanly', async () => {
    const provider = new OpenRouterSearchProvider({
      apiKey: 'test-key',
      fetchFn: async () => {
        return new Response('Not valid json {', {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    });

    const res = await provider.search('Query');
    assert.equal(res.success, false);
    assert.ok(res.error.includes('Malformed response from provider'));
    assert.equal(res.searchUsed, false);
    assert.equal(res.searchRequests, null);
    assert.equal(res.searchEvidence, 'none');
    assert.deepEqual(res.sources, []);
  });

  await t.test('handles network error cleanly and redacts API key', async () => {
    const secretKey = 'sk-or-v1-my-secret-key';
    const provider = new OpenRouterSearchProvider({
      apiKey: secretKey,
      fetchFn: async () => {
        throw new Error(`fetch failed with ${secretKey}`);
      }
    });

    const res = await provider.search('Query');
    assert.equal(res.success, false);
    assert.ok(res.error.includes('Network error'));
    assert.ok(!res.error.includes(secretKey));
    assert.ok(res.error.includes('[REDACTED]'));
  });
});
