// DeepSeek client (OpenAI-compatible) + schema repair.
//
// DeepSeek's json_object mode guarantees *syntactically valid* JSON, not schema
// conformance — there is no structured-outputs equivalent. So every response
// goes through validateReport(), and a response that fails to parse at all gets
// exactly one retry with a corrective nudge appended.
//
// If malformed output ever exceeds ~5% in practice, switch USE_TOOL_CALLS to
// true: DeepSeek supports tool calling, and a single forced function gives the
// model a grammar-constrained target. Both paths live behind callDeepSeek() so
// it's a one-line change.

import { validateReport, emptyReport, COMPANY_SCHEMA } from '../shared/schema.js';
import { DEEPSEEK_MAX_TOKENS } from '../shared/constants.js';
import { fetchJson, HttpError } from './http.js';

const USE_TOOL_CALLS = false;
const TOOL_NAME = 'submit_company_report';

export class DeepSeekError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'DeepSeekError';
    this.code = code;
    this.status = status;
  }
}

function endpoint(base) {
  const b = (base || 'https://api.deepseek.com').replace(/\/+$/, '');
  // DeepSeek accepts both the bare host and one already ending in /v1, so no
  // version juggling is needed — appending the path works for either.
  return `${b}/chat/completions`;
}

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function extractContent(json) {
  if (USE_TOOL_CALLS) {
    const call = json?.choices?.[0]?.message?.tool_calls?.[0];
    if (call?.function?.arguments) return call.function.arguments;
    return null;
  }
  return json?.choices?.[0]?.message?.content ?? null;
}

async function request(settings, messages, timeoutMs) {
  const body = {
    model: settings.deepseekModel || 'deepseek-flash',
    messages,
    temperature: 0.1,
    max_tokens: DEEPSEEK_MAX_TOKENS,
  };

  if (USE_TOOL_CALLS) {
    body.tools = [{
      type: 'function',
      function: {
        name: TOOL_NAME,
        description: 'Submit the completed company research report.',
        parameters: COMPANY_SCHEMA,
      },
    }];
    body.tool_choice = { type: 'function', function: { name: TOOL_NAME } };
  } else {
    body.response_format = { type: 'json_object' };
  }

  try {
    return await fetchJson(endpoint(settings.deepseekBase), {
      method: 'POST',
      headers: headers(settings.deepseekKey),
      body,
      timeoutMs,
      label: 'deepseek',
    });
  } catch (e) {
    if (e instanceof HttpError) {
      const hint = {
        401: 'DeepSeek rejected the API key (401). Check it in settings.',
        402: 'DeepSeek reports insufficient balance (402). Top up your account.',
        429: 'DeepSeek rate limit reached (429). Slowing down.',
      }[e.status] || `DeepSeek request failed (${e.status}).`;
      throw new DeepSeekError('DEEPSEEK_HTTP', hint, e.status);
    }
    throw new DeepSeekError('NETWORK', e?.message || 'Network request to DeepSeek failed.');
  }
}

/**
 * @returns {{report: object, repairs: string[], usage: object|null, attempts: number}}
 * @throws {DeepSeekError}
 */
export async function callDeepSeek(settings, { system, user, timeoutMs = 30000 }) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  let lastJson = null;
  let lastErr = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const json = await request(settings, messages, timeoutMs);
    lastJson = json;

    const content = extractContent(json);
    if (content) {
      const { report, repairs } = validateReport(content);
      // A report with no companyName at all means the model produced nothing
      // usable — treat it as a parse failure and retry once.
      if (report.companyName || repairs.length === 0 || attempt === 1) {
        return {
          report,
          repairs,
          usage: json?.usage || null,
          attempts: attempt + 1,
        };
      }
      lastErr = new Error('response carried no companyName');
    } else {
      lastErr = new Error('no content in response');
      // `finish_reason` is the whole diagnosis: "length" means the cap was hit
      // and reasoning_content below is where the answer went.
      const choice = json?.choices?.[0];
      console.warn(
        '[JCE] deepseek empty content',
        'finish_reason=' + (choice?.finish_reason ?? 'none'),
        'reasoning_chars=' + (choice?.message?.reasoning_content?.length ?? 0),
        JSON.stringify(json).slice(0, 400),
      );
    }

    if (attempt === 0) {
      // One corrective retry. Naming the failure is what makes the retry work.
      messages.push({
        role: 'assistant',
        content: typeof content === 'string' ? content.slice(0, 2000) : '(empty)',
      });
      messages.push({
        role: 'user',
        content: 'Your previous reply was not valid JSON matching the schema. '
          + 'Reply with ONLY the JSON object, no prose, no code fence, and include '
          + 'every required field. Use null for anything the search results do not state.',
      });
    }
  }

  console.warn('[JCE] deepseek unusable after retry', lastErr?.message, JSON.stringify(lastJson).slice(0, 400));
  throw new DeepSeekError(
    'DEEPSEEK_BAD_JSON',
    'DeepSeek returned a malformed response. Retrying may help.',
  );
}

/** Minimal connectivity probe for the options page. */
export async function testKey(settings, timeoutMs = 15000) {
  const started = Date.now();
  const model = settings.deepseekModel || 'deepseek-flash';
  try {
    const json = await fetchJson(endpoint(settings.deepseekBase), {
      method: 'POST',
      headers: headers(settings.deepseekKey),
      body: {
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        // Not 5. A model that emits any reasoning before its answer spends the
        // whole budget getting there, and a 200 with empty content is returned —
        // which looks exactly like a broken key but is really a truncated reply.
        max_tokens: 64,
      },
      timeoutMs,
      retries: 0,
      label: 'deepseek-test',
    });

    const choice = json?.choices?.[0];
    const content = choice?.message?.content;
    if (content) return { ok: true, ms: Date.now() - started };

    // A 200 carrying no content is the confusing case, so say *why* rather than
    // reporting "empty response": finish_reason "length" means the token budget
    // ran out, and a populated reasoning_content means the model spent it there.
    const finish = choice?.finish_reason;
    const reasoning = choice?.message?.reasoning_content;
    const why = finish === 'length'
      ? `ran out of tokens before answering (model "${model}" may be a reasoning model)`
      : reasoning
        ? 'put its output in reasoning_content, not content'
        : `returned no content (finish_reason: ${finish ?? 'none'})`;

    console.warn('[JCE] deepseek-test empty:', JSON.stringify(json).slice(0, 600));
    return { ok: false, ms: Date.now() - started, error: `DeepSeek ${why}` };
  } catch (e) {
    const status = e instanceof HttpError ? e.status : undefined;
    const detail = {
      401: 'DeepSeek rejected the API key (401)',
      402: 'DeepSeek reports insufficient balance (402)',
      429: 'DeepSeek rate limit reached (429)',
    }[status] || e?.message || String(e);
    return { ok: false, ms: Date.now() - started, error: detail, status };
  }
}

export { emptyReport };
