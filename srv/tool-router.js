'use strict';
/**
 * tool-router.js — Dynamic Tool Retrieval (Tool RAG / Tool Router)
 *
 * Two-stage pipeline:
 *   1. Shallow Extraction  – strip full schemas down to { name, description }
 *   2. Fast LLM Router     – cheap model classifies which tools are needed
 *   3. Schema Hydration    – map names back to full schemas
 *
 * The router runs ONCE per user turn, before the agenticToolLoop begins.
 * If the router times out or returns unparseable JSON it falls back gracefully.
 */

const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { GENHUB_CLAUDE_DEPLOYMENT } = require('./lib/utils/constants');

// ── Config ────────────────────────────────────────────────────────────────────
const ROUTER_TIMEOUT_MS   = 8_000;   // fast model; anything longer is a hung call
const ROUTER_MAX_TOKENS   = 300;     // a JSON array of tool names is always short
const MAX_TOOLS_TO_INJECT = 10;      // hard ceiling on hydrated tools passed to LLM
const ROUTER_CONTEXT_MSGS = 3;       // how many recent USER messages to include for context

// Tools that are always included regardless of what the router decides.
// Useful for meta-tools like session/auth probes that the router might miss.
const ALWAYS_INCLUDE_TOOLS = [
  // e.g. 'adt_get_system_info'
];

// ── Logging ───────────────────────────────────────────────────────────────────
function routerLog(level, event, payload = {}) {
  const line = `[ToolRouter] ${event} | ${JSON.stringify({ ts: new Date().toISOString(), level, event, ...payload })}`;
  if      (level === 'ERROR') console.error(line);
  else if (level === 'WARN')  console.warn(line);
  else                        console.log(line);
}

// ── Step 1 — Shallow Extraction ───────────────────────────────────────────────
/**
 * Strip full MCP schemas down to just name + description.
 * This is the "Tool Directory" injected into the router prompt.
 *
 * @param {Array<{name:string, description:string, [key:string]:any}>} allTools
 * @returns {Array<{name:string, description:string}>}
 */
function shallowExtract(allTools) {
  return allTools.map(t => ({
    name:        t.name,
    description: (t.description || '').slice(0, 200) // cap per-tool description length
  }));
}

// ── Step 2 — Fast LLM Router ─────────────────────────────────────────────────
const ROUTER_SYSTEM_PROMPT =
  'You are a tool-routing agent. You map user requests to the required system tools. ' +
  'You will receive a JSON array of available tools, each with a name and description. ' +
  'Analyze the user prompt and return a strict JSON array of string tool names needed ' +
  'to answer the prompt — for example: ["tool_a","tool_b"]. ' +
  'Rules: ' +
  '(1) If no tools are needed return an empty array []. ' +
  '(2) Return ONLY the JSON array. No markdown, no backticks, no explanation. ' +
  '(3) Include all tools that could plausibly help, including alternatives ' +
'that serve the same goal via different mechanisms (e.g. both a query tool ' +
'and a table browser tool for data retrieval requests).';

/**
 * Call the router model via SAP GenAI Hub (Claude deployment, low temperature).
 * Uses the Bedrock-compatible invoke format that GENHUB_CLAUDE_DEPLOYMENT expects.
 * Returns the raw text response or throws on timeout / HTTP error.
 */
async function callRouterLLM(routerPrompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTER_TIMEOUT_MS);

  try {
    const response = await executeHttpRequest(
      { destinationName: 'GENERATIVE_AI_HUB' },
      {
        method:  'POST',
        url:     `/inference/deployments/${GENHUB_CLAUDE_DEPLOYMENT}/invoke`,
        headers: { 'Content-Type': 'application/json', 'AI-Resource-Group': 'default' },
        data: {
          anthropic_version: 'bedrock-2023-05-31',
          system:            ROUTER_SYSTEM_PROMPT,
          max_tokens:        ROUTER_MAX_TOKENS,
          messages: [
            { role: 'user', content: routerPrompt }
          ]
        }
      },
      { fetchCsrfToken: false, fetchOptions: { signal: controller.signal } }
    );

    // Claude response shape: { content: [{ type: 'text', text: '...' }] }
    const blocks = response.data?.content || [];
    return blocks.filter(b => b.type === 'text').map(b => b.text).join('') || '';
  } finally {
    clearTimeout(timer);
  }
}

// ── Step 3 — Parse & validate router output ───────────────────────────────────
/**
 * Parse the router's raw text into an array of tool name strings.
 * Strips markdown code fences defensively.
 */
function parseRouterOutput(raw) {
  // Strip ```json ... ``` or ``` ... ``` wrappers the model sometimes emits
  const stripped = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  const parsed = JSON.parse(stripped); // throws on malformed JSON → caught by caller

  if (!Array.isArray(parsed)) throw new Error('Router returned non-array JSON');
  if (!parsed.every(x => typeof x === 'string')) throw new Error('Router array contains non-string');
  return parsed;
}

// ── Step 4 — Schema Hydration ─────────────────────────────────────────────────
/**
 * Given an array of tool name strings identified by the router,
 * return the full MCP JSON schemas for those tools only.
 *
 * @param {string[]}  toolNamesArray   Names the router chose
 * @param {object[]}  allTools         Full schema objects from mcpBridge
 * @returns {object[]}
 */
function hydrateToolSchemas(toolNamesArray, allTools) {
  const nameSet = new Set([...toolNamesArray, ...ALWAYS_INCLUDE_TOOLS]);
  return allTools.filter(t => nameSet.has(t.name));
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Main entry-point called once per user turn.
 *
 * @param {string}    prompt      The current user prompt
 * @param {string}    sessionId   Used only for logging
 * @param {object[]}  allTools    Full tool schemas from mcpBridge.getToolsForLLM()
 * @param {object[]}  [history]   Recent conversation history for context
 * @returns {Promise<object[]>}   Hydrated subset of tool schemas (2–10 tools)
 */
async function routeRelevantTools(prompt, sessionId, allTools, history = []) {
  if (!allTools || allTools.length === 0) return [];

  // Build the router prompt: tool directory + recent context + user prompt
  const directory   = shallowExtract(allTools);
  // Only use user-role messages for context — assistant/tool turns have empty or
  // structured content that gives the router no useful signal.
  const recentUserMsgs = history
    .filter(m => m.role === 'user' && typeof m.content === 'string' && m.content.trim())
    .slice(-ROUTER_CONTEXT_MSGS);
  const contextText = recentUserMsgs.length > 0
    ? '\n\nRecent user messages (for disambiguation only):\n' +
      recentUserMsgs.map(m => `- ${m.content.slice(0, 300)}`).join('\n')
    : '';

  const routerPrompt =
    `Available tools (name + description only):\n${JSON.stringify(directory, null, 0)}` +
    contextText +
    `\n\nUser request: ${prompt.slice(0, 1000)}`;

  routerLog('INFO', 'ROUTE_START', {
    sessionId,
    totalTools:    allTools.length,
    promptPreview: prompt.slice(0, 120)
  });

  let chosenNames = [];

  try {
    const raw      = await callRouterLLM(routerPrompt);
    chosenNames    = parseRouterOutput(raw);

    routerLog('INFO', 'ROUTE_OK', {
      sessionId,
      chosen:    chosenNames,
      chosenLen: chosenNames.length
    });
  } catch (err) {
    // Graceful fallback — router failure must NEVER block the main request.
    // Returning [] means agenticToolLoop will run without tools, which is
    // still safe (the main model can answer from its own knowledge).
    routerLog('WARN', 'ROUTE_FALLBACK', {
      sessionId,
      reason: err?.name === 'AbortError' ? 'timeout' : err?.message
    });
    return []; // fallback: no tools
  }

  const hydrated = hydrateToolSchemas(chosenNames, allTools);

  // Enforce hard ceiling to prevent accidentally injecting too many schemas
  const capped = hydrated.slice(0, MAX_TOOLS_TO_INJECT);

  if (capped.length < hydrated.length) {
    routerLog('WARN', 'ROUTE_CAPPED', {
      sessionId,
      hydrated: hydrated.length,
      capped:   capped.length
    });
  }

  routerLog('INFO', 'ROUTE_HYDRATED', {
    sessionId,
    injectedTools: capped.map(t => t.name)
  });

  return capped;
}

module.exports = { routeRelevantTools, hydrateToolSchemas, shallowExtract };