'use strict';

// ── System prompt ─────────────────────────────────────────────────────────────
const GLOBAL_SYSTEM_INSTRUCTION =
    'You are an expert SAP developer specializing in ABAP. ' +
    'CRITICAL RULES: ' +
    '1. Wrap your ENTIRE response in a single ```abap block. NO EXCEPTIONS. ' +
    '2. NO CONVERSATION. No apologies, no explanations, no validation logs. Output ONLY code. ' +
    '3. Replace every obsolete/Classic API/deprecated object with its exact ABAP Cloud Tier 1 equivalent. ' +
    '4. NEVER delete functionality to avoid errors — provide the modern equivalent. ' +
    '5. NO PSEUDO-CODE. Write executable, active ABAP code only.';

// ── Limits ────────────────────────────────────────────────────────────────────
const MAX_RETRIES              = 2;
const MAX_CHATS_PER_USER       = 10;
const MAX_PROMPTS_PER_SESSION  = 20;
const MAX_HISTORY_MESSAGES     = 6;
const CHARS_PER_TOKEN          = 4;
const MAX_INPUT_TOKENS         = 60_000;
const GPT_MAX_INPUT_TOKENS     = 10_000;
const CLAUDE_MAX_INPUT_TOKENS  = 15_000;
const MAX_OUTPUT_TOKENS_GPT    = 4_096;
const MAX_OUTPUT_TOKENS_CLAUDE = 4_096;

// ── Models ────────────────────────────────────────────────────────────────────
const CLAUDE_MODEL_SIMPLE  = 'claude-sonnet-4-6';
const CLAUDE_MODEL_COMPLEX = 'claude-opus-4-6';

// ── GenAI Hub deployment IDs ──────────────────────────────────────────────────
// Override via environment variables in BTP CF so you never have to redeploy to rotate
const GENHUB_CLAUDE_DEPLOYMENT = process.env.GENHUB_CLAUDE_DEPLOYMENT || 'dacd7fd5faf9cdb9';
const GENHUB_GEMINI_DEPLOYMENT = process.env.GENHUB_GEMINI_DEPLOYMENT || 'da91e1d34210e9fb';
const GENHUB_GPT_DEPLOYMENT    = process.env.GENHUB_GPT_DEPLOYMENT    || 'd905723f4f0b8b08';

// ── File upload ───────────────────────────────────────────────────────────────
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES  = new Set([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

// ── Auth ──────────────────────────────────────────────────────────────────────
const MAX_FAILED_LOGINS     = 5;
const ACCOUNT_LOCK_DURATION = 15 * 60 * 1000; // 15 min in ms
const OTP_EXPIRY_MINUTES    = 10;
const BCRYPT_ROUNDS         = 12;
const ALLOWED_EMAIL_DOMAIN  = '@answerthink.com';

// ── ABAP validation ───────────────────────────────────────────────────────────
const ABAP_IGNORE_PHRASES = [
    'align ', 'change if to case', 'end of line comments', 'name too long',
    'remove double space', 'implicit start-of-selection', 'text element',
    'exit is not allowed', 'specify table key', 'functional writing style',
    'indentation', 'does not match pattern', 'main file must have specific contents',
    'only one statement is allowed', 'hungarian notation', 'is obsolete',
    'statement does not exist', 'reduce procedural code', 'add order by',
    'remove space', 'remove whitespace', 'start statement at tab', 'strict sql',
    'unnecessary chaining', 'must be escaped with @', 'empty event',
    'specify table type', 'not found, findtop'
];

const GITHUB_BASE         = 'https://raw.githubusercontent.com/SAP/abap-atc-cr-cv-s4hc/main/src';
const SAP_RELEASE_VERSION = 'PCE2023_0';

const ABAP_OBJECT_TYPE_PATTERNS = [
    { type: 'TYPE',             regex: /\bTYPE\s+(?:TABLE OF\s+|STANDARD TABLE OF\s+|SORTED TABLE OF\s+|HASHED TABLE OF\s+)?([\\/A-Za-z0-9_]+)/gi },
    { type: 'FROM',             regex: /\bFROM\s+([\\/A-Za-z0-9_]+)/gi },
    { type: 'JOIN',             regex: /\bJOIN\s+([\\/A-Za-z0-9_]+)/gi },
    { type: 'INTO TABLE',       regex: /\bINTO\s+(?:TABLE\s+)?@?([\\/A-Za-z0-9_]+)/gi },
    { type: 'REF TO',           regex: /\bREF\s+TO\s+([\\/A-Za-z0-9_]+)/gi },
    { type: 'CALL FUNCTION',    regex: /\bCALL\s+FUNCTION\s+'([\\/A-Za-z0-9_]+)'/gi },
    { type: 'CALL METHOD',      regex: /\bCALL\s+METHOD\s+([\\/A-Za-z0-9_]+)/gi },
    { type: 'CLASS',            regex: /\b((?:CL|IF|CX|BP|BL|CA|CB|CC|CD|CE|CF|CG|CH|CI|CJ|CK|CM|CN|CO|CP|CQ|CR|CS|CT|CU|CV|CW|CX|CY|CZ)_[A-Za-z0-9_\\/]+)\b/gi },
    { type: 'STATIC CALL',      regex: /([\\/A-Za-z0-9_]+)=>/gi },
    { type: 'BAPI',             regex: /\b(BAPI_[A-Za-z0-9_\\/]+)\b/gi },
    { type: 'INCLUDE',          regex: /\bINCLUDE\s+([\\/A-Za-z0-9_]+)/gi },
    { type: 'TABLES',           regex: /\bTABLES\s*:\s*([\\/A-Za-z0-9_,\s]+)/gi },
    { type: 'SELECT-OPTIONS',   regex: /\bSELECT-OPTIONS\s+\w+\s+FOR\s+([\\/A-Za-z0-9_]+)-/gi },
    { type: 'PARAMETERS TYPE',  regex: /\bPARAMETERS\s+\w+\s+TYPE\s+([\\/A-Za-z0-9_]+)/gi },
    { type: 'RANGES',           regex: /\bRANGES\s+\w+\s+FOR\s+([\\/A-Za-z0-9_]+)-/gi },
    { type: 'AUTHORITY-CHECK',  regex: /\bAUTHORITY-CHECK\s+OBJECT\s+'([\\/A-Za-z0-9_]+)'/gi },
    { type: 'CALL TRANSACTION', regex: /\bCALL\s+TRANSACTION\s+'([\\/A-Za-z0-9_]+)'/gi },
    { type: 'MESSAGE',          regex: /\bMESSAGE\s+\w+\(\s*([\\/A-Za-z0-9_]+)\s*\)/gi },
    { type: 'ENHANCEMENT',      regex: /\b((?:ES|BADI|BADI_DEF)_[A-Za-z0-9_\\/]+)\b/gi },
    { type: 'FUNCTION GROUP',   regex: /\b((?:SAPL|FG_)[A-Za-z0-9_\\/]+)\b/gi }
];

const ABAP_PRIMITIVE_TYPES = new Set([
    'STRING','XSTRING','INT1','INT2','INT4','INT8','FLOAT','DECFLOAT16','DECFLOAT34',
    'NUMC','CHAR','DATS','TIMS','PACK','HEX','CLNT','LANG','UNIT','CUKY','CURR',
    'DEC','FLTP','PREC','QUAN','SSTRING','RAWSTRING',
    'I','D','T','F','C','N','X','P',
    'TABLE','ANY','STANDARD','DATA','REF','TO','OF',
    'ABAP_BOOL','ABAP_TRUE','ABAP_FALSE','SPACE','SY','SYST'
]);

const RE_ABAP_VAR_PREFIX = /^(LV_|LS_|LT_|GV_|GS_|GT_|IV_|IS_|IT_|EV_|ES_|ET_|CV_|CS_|CT_|RV_|RS_|RT_|MV_|MS_|MT_|WA_|ST_|P_|S_|LO_|MO_|AO_|GO_|IO_|EO_|RO_|CO_|TY_)/i;
const RE_ABAP_KEYWORDS   = /^(BEGIN|END|TYPES|DATA|FIELD|LINE|LOOP|SELECT|INSERT|UPDATE|DELETE|WHERE|INTO|FROM|AND|NOT|OR|IF|ELSE|ENDIF|ENDLOOP|EXIT|CONTINUE|RETURN|PERFORM|FORM|ENDFORM|WRITE|MESSAGE|APPEND|CLEAR|MOVE|ADD|SUBTRACT|MULTIPLY|DIVIDE|CONCATENATE|SPLIT|CONDENSE|TRANSLATE|SHIFT|REPLACE|SEARCH|MODIFY|COLLECT|SORT|READ|FIND|DESCRIBE|ASSIGN|CHECK|RAISE|CATCH|TRY|ENDTRY|RESUME|RETRY|CLEANUP|METHODS|INTERFACES|ALIASES|PROTECTED|PRIVATE|PUBLIC|CLASS|ENDCLASS|METHOD|ENDMETHOD|SECTION|IMPLEMENTATION|DEFINITION)$/i;
const RE_DIGITS_ONLY     = /^\d+$/;

const SAP_ALWAYS_VALID_OBJECTS = new Set([
    'BAPI_TRANSACTION_COMMIT','BAPI_TRANSACTION_ROLLBACK',
    'BAPIRET2','BAPIRET1','BAPIPAREX','BAPIPARAM','BAPILOGDET',
    'BAPI_RETURN','BAPIMSGKY','BAPIADDR1','BAPIADDR2',
    'LIKP','LIPS','MARA','MARC','MARD','MCHB','MKPF','MSEG',
    'VBAK','VBAP','VBEP','VBFA','VBKD','VBPA','VBUK','VBUP',
    'KNA1','KNB1','LFA1','LFB1','EKKO','EKPO','EKET',
    'T001','T001W','T006','T006A','TCURR','TCURF',
    'AUFK','AUFP','CRHD','CRCO',
    'ABAP_BOOL','ABAP_TRUE','ABAP_FALSE','ABAP_ENCODING',
    'SY','SYST','SPACE'
]);

module.exports = {
    GLOBAL_SYSTEM_INSTRUCTION,
    MAX_RETRIES, MAX_CHATS_PER_USER, MAX_PROMPTS_PER_SESSION,
    MAX_HISTORY_MESSAGES, CHARS_PER_TOKEN, MAX_INPUT_TOKENS,
    GPT_MAX_INPUT_TOKENS, CLAUDE_MAX_INPUT_TOKENS,
    MAX_OUTPUT_TOKENS_GPT, MAX_OUTPUT_TOKENS_CLAUDE,
    CLAUDE_MODEL_SIMPLE, CLAUDE_MODEL_COMPLEX,
    GENHUB_CLAUDE_DEPLOYMENT, GENHUB_GEMINI_DEPLOYMENT, GENHUB_GPT_DEPLOYMENT,
    MAX_FILE_SIZE_BYTES, ALLOWED_MIME_TYPES,
    MAX_FAILED_LOGINS, ACCOUNT_LOCK_DURATION, OTP_EXPIRY_MINUTES,
    BCRYPT_ROUNDS, ALLOWED_EMAIL_DOMAIN,
    ABAP_IGNORE_PHRASES, GITHUB_BASE, SAP_RELEASE_VERSION,
    ABAP_OBJECT_TYPE_PATTERNS, ABAP_PRIMITIVE_TYPES,
    RE_ABAP_VAR_PREFIX, RE_ABAP_KEYWORDS, RE_DIGITS_ONLY,
    SAP_ALWAYS_VALID_OBJECTS
};
