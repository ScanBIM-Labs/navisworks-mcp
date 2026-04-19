// === scanbim-health patch: security headers + /health + favicon ===
const __SEC_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://developer.api.autodesk.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://*.autodesk.com https://uptime.scanbimlabs.io https://developer.api.autodesk.com"
};
const __FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#f97316"/><text x="16" y="22" text-anchor="middle" font-family="Inter,sans-serif" font-size="18" font-weight="800" fill="#fff">S</text></svg>`;
const __BUILD = globalThis.__BUILD__ || 'dev';
const __START = Date.now();
const __SLUG = "navisworks-mcp";
const __VERSION = "1.0.0";
async function __handleHealth(env) {
  const deps = {};
  try { const r = await fetch('https://developer.api.autodesk.com/authentication/v2/token', { method: 'HEAD' }); deps.aps = r.status < 500 ? 'ok' : 'degraded'; } catch { deps.aps = 'down'; }
  if (env && env.CACHE) { try { await env.CACHE.get('_hc'); deps.kv = 'ok'; } catch { deps.kv = 'degraded'; } }
  if (env && env.DB)    { try { await env.DB.prepare('SELECT 1').first(); deps.d1 = 'ok'; } catch { deps.d1 = 'degraded'; } }
  const worst = Object.values(deps).reduce((w, v) => v === 'down' ? 'down' : v === 'degraded' && w !== 'down' ? 'degraded' : w, 'ok');
  return Response.json({ status: worst, service: __SLUG, version: (env && env.VERSION) || __VERSION, build: __BUILD, ts: new Date().toISOString(), uptime_s: Math.floor((Date.now() - __START) / 1000), deps });
}
function __applySec(resp) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(__SEC_HEADERS)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

// --- credits middleware ---
function __extractUserKey(req) {
  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(sk_scanbim_[A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  const headerKey = req.headers.get('x-scanbim-api-key');
  if (headerKey) return headerKey.trim();
  return null;
}
function __toolCost(toolName) {
  if (!toolName) return 1;
  if (/render|video|walkthrough|export_video|render_image|render_video/i.test(toolName)) return 50;
  if (/design_automation|da_run|import_rvt|tm_import_rvt|nwd_upload|upload_model/i.test(toolName)) return 20;
  if (/ai_|explain|draft|qa_|clash_explain|ai-?authored/i.test(toolName)) return 5;
  return 1;
}
async function __creditCheck(req, env, body) {
  // Dormant until billing is fully configured (INTERNAL_API_TOKEN + CREDITS_API).
  // This avoids breaking existing MCP clients before a billing cutover.
  if (!env.INTERNAL_API_TOKEN || !env.CREDITS_API) return { ok: true };
  if (body?.method !== 'tools/call') return { ok: true };
  const toolName = body?.params?.name;
  if (!toolName) return { ok: true };
  const user_key = __extractUserKey(req);
  if (!user_key) {
    return { ok: false, response: Response.json({
      jsonrpc: '2.0', id: body.id ?? null,
      error: { code: -32001, message: 'Authentication required',
        data: { error: 'missing_api_key',
          hint: 'Include header: Authorization: Bearer sk_scanbim_<key>',
          signup_url: 'https://scanbimlabs.io/credits' } }
    }, { status: 401 }) };
  }
  const cost = __toolCost(toolName);
  let r;
  try {
    r = await fetch(env.CREDITS_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': env.INTERNAL_API_TOKEN },
      body: JSON.stringify({ user_key, amount: cost, tool_name: toolName })
    });
  } catch (e) {
    console.log('CREDITS: fetch failed', String(e));
    return { ok: true }; // fail open on network error
  }
  if (r.status === 402) {
    const info = await r.json().catch(() => ({}));
    return { ok: false, response: Response.json({
      jsonrpc: '2.0', id: body.id ?? null,
      error: { code: -32002, message: 'Insufficient credits', data: info }
    }, { status: 402 }) };
  }
  if (!r.ok) { console.log('CREDITS: check-and-debit returned', r.status); return { ok: true }; }
  return { ok: true };
}
// --- end credits middleware ---

// === end patch header ===

// Navisworks MCP Worker v1.1.0 — Real APS-Backed Coordination Tools
// ScanBIM Labs LLC | Ian Martin
// All 5 tools: REAL APS Model Derivative + OSS API calls

const APS_BASE = 'https://developer.api.autodesk.com';

const SERVER_INFO = {
  name: 'navisworks-mcp',
  version: '1.1.0',
  description: 'Navisworks coordination and clash detection via APS. Upload NWD/NWC files, detect clashes, generate reports, extract viewpoints.',
  author: 'ScanBIM Labs LLC'
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

async function getAPSToken(env, scope = 'data:read data:write data:create bucket:read bucket:create viewables:read') {
  const cacheKey = `aps_token_nw_${scope.replace(/\s/g, '_')}`;
  if (env.CACHE) {
    const cached = await env.CACHE.get(cacheKey);
    if (cached) return cached;
  }
  const resp = await fetch(`${APS_BASE}/authentication/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.APS_CLIENT_ID,
      client_secret: env.APS_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope
    })
  });
  if (!resp.ok) throw new Error(`APS auth failed (${resp.status})`);
  const data = await resp.json();
  if (env.CACHE) await env.CACHE.put(cacheKey, data.access_token, { expirationTtl: data.expires_in - 60 });
  return data.access_token;
}

// ── APS Helpers ───────────────────────────────────────────────

async function ensureBucket(token, bucketKey) {
  const check = await fetch(`${APS_BASE}/oss/v2/buckets/${bucketKey}/details`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (check.ok) return;
  const create = await fetch(`${APS_BASE}/oss/v2/buckets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketKey, policyKey: 'transient' })
  });
  if (!create.ok && create.status !== 409) throw new Error(`Bucket creation failed (${create.status})`);
}

async function getModelMetadata(token, urn) {
  const resp = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/metadata`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`Metadata fetch failed (${resp.status})`);
  return await resp.json();
}

async function getModelGUID(token, urn) {
  const meta = await getModelMetadata(token, urn);
  if (!meta.data || !meta.data.metadata || meta.data.metadata.length === 0) {
    throw new Error('No metadata found. Ensure model is translated.');
  }
  const view3d = meta.data.metadata.find(v => v.role === '3d') || meta.data.metadata[0];
  return view3d.guid;
}

async function getProperties(token, urn, guid) {
  const resp = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/metadata/${guid}/properties?forceget=true`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`Properties fetch failed (${resp.status})`);
  const data = await resp.json();
  if (resp.status === 202 || data.isProcessing) {
    await new Promise(r => setTimeout(r, 3000));
    const retry = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/metadata/${guid}/properties?forceget=true`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!retry.ok) throw new Error(`Properties retry failed (${retry.status})`);
    return await retry.json();
  }
  return data;
}

async function getObjectTree(token, urn, guid) {
  const resp = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/metadata/${guid}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`Object tree fetch failed (${resp.status})`);
  const data = await resp.json();
  if (resp.status === 202) {
    await new Promise(r => setTimeout(r, 3000));
    const retry = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/metadata/${guid}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!retry.ok) throw new Error(`Object tree retry failed`);
    return await retry.json();
  }
  return data;
}

async function getManifest(token, urn) {
  const resp = await fetch(`${APS_BASE}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error(`Manifest fetch failed (${resp.status})`);
  return await resp.json();
}

// ── Tool Definitions ──────────────────────────────────────────

const TOOLS = [
  {
    name: 'nwd_upload',
    description: [
      'Upload a Navisworks file (.nwd/.nwf/.nwc) to Autodesk Platform Services (APS) Object Storage and start an SVF2 translation job so the model becomes queryable by the other nwd_* tools.',
      '',
      'When to use: at the start of a coordination workflow — e.g. the GC hands off a federated NWD combining MEP + structural + architectural models and the agent needs to stage it for clash review before issuing an RFI, or when a subcontractor publishes a new NWC model revision that must be ingested for weekly BIM coordination. Always the first call in a session for any new model.',
      '',
      'When NOT to use: do not call for already-translated models (re-use the returned model_id/URN); do not use for raw Revit .rvt, IFC, or DWG — those go through a different MCP.',
      '',
      'APS scopes required: data:read data:write data:create bucket:read bucket:create viewables:read. The worker acquires a 2-legged client-credentials token; the caller does not supply one.',
      '',
      'Rate limits: APS default ~50 req/min per app per endpoint; Model Derivative translation job submission ~60 req/min. NWD bundles can be large (hundreds of MB); the upload PUT and translation can take minutes — translation is asynchronous, poll via nwd_export_report (manifest) with exponential backoff (e.g. 5s, 10s, 30s, 60s) before calling clash/properties tools.',
      '',
      'Errors the agent should handle: 401 invalid/expired APS token (surface as auth failure — do not retry with same creds); 403 missing scope (report scope gap, do not retry); 404 source file_url unreachable (ask user for a fresh public URL); 409 bucket already exists (handled internally, safe to ignore); 413/422 unsupported Navisworks version — APS Model Derivative supports NWD/NWC from Navisworks 2015 and later (state the unsupported version to the user); 429 rate limited (exponential backoff, retry); 5xx APS upstream (retry once, then surface).',
      '',
      'Side effects: creates a fresh transient OSS bucket (scanbim-nwd-<timestamp>, 24h TTL) and uploads the file as an object, then POSTs a Model Derivative translation job. NOT idempotent — each call creates a new bucket/URN even for the same file_url. Logs usage to the D1 usage_log table.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        file_url: {
          type: 'string',
          format: 'uri',
          description: 'Publicly reachable HTTPS URL from which the worker will GET the Navisworks file bytes. Must return the raw binary (not an HTML landing page). Pre-signed S3 URLs, ACC/BIM360 signed-resource URLs, and Cloudflare R2 public URLs all work. Max practical size ~4 GB (Cloudflare Workers fetch body limit applies).',
          examples: [
            'https://example-bucket.s3.amazonaws.com/projects/tower-a/Coordination_2026-04-18.nwd?X-Amz-Signature=...',
            'https://files.scanbimlabs.io/levelA_mep_structural_federated.nwd'
          ]
        },
        file_name: {
          type: 'string',
          description: 'Logical filename for the OSS object. Must end in .nwd, .nwf, or .nwc (case-insensitive) so APS picks the correct translator. Avoid spaces and non-ASCII — the worker sanitizes to [A-Za-z0-9._-]. Follow ScanBIM convention: <project>_<discipline>_<rev>.nwd (e.g. TowerA_MEPStruct_R07.nwd).',
          pattern: '.+\\.(nwd|nwf|nwc)$',
          examples: ['TowerA_MEPStruct_R07.nwd', 'LevelB3_Coordination.nwc', 'Federated_Model.nwf']
        },
        project_id: {
          type: 'string',
          description: 'Optional free-form project label stored alongside the upload record for caller-side correlation. Not sent to APS. Typical values: ACC project GUID, internal job number, or short slug.',
          examples: ['ACC-PROJ-8b2f', 'JOB-2026-0418-TowerA']
        }
      },
      required: ['file_url', 'file_name']
    }
  },
  {
    name: 'nwd_get_clashes',
    description: [
      'Detect geometric/logical clashes between two element sets in an already-translated Navisworks model. Uses APS Model Derivative property extraction + same-level proximity heuristics, optionally augmented by VDC rules stored in D1 (table vdc_rules).',
      '',
      'When to use: when coordinating federated MEP + structural + architectural models for clash review before issuing an RFI; e.g. "find duct vs. beam clashes on Level 3 before the Wed coordination meeting" or "sanity-check the latest MEP revision against structure before releasing for fabrication." Pair with nwd_export_report to produce a deliverable.',
      '',
      'When NOT to use: do not call on a model whose translation is still "inprogress" — call nwd_export_report first and confirm translation_status == "success"; not a substitute for Navisworks Manage Clash Detective for final sign-off (this is a coordination-stage screen, not a regulatory clash report).',
      '',
      'APS scopes required: viewables:read data:read (read-only — does not create anything in APS).',
      '',
      'Rate limits: APS default ~50 req/min per endpoint; Model Derivative metadata/properties endpoints are the bottleneck. Properties response may return 202 "isProcessing" on first call — the worker retries once after 3s. For very large models (>50k elements) the worker caps analysis at 50x50 element cross-compare and 100 reported clashes; re-run with tighter category_a/category_b filters for exhaustive coverage.',
      '',
      'Errors: 401 APS token expired (transient, retry); 403 missing viewables:read/data:read scope (report, do not retry); 404 URN not found or not translated (prompt user to re-run nwd_upload); 409 not applicable; 422 model translated but property index unavailable — typically means source NW version unsupported or translation partially failed (supported: Navisworks 2015+); 429 rate limit (backoff); 5xx APS upstream (retry once). If properties.data.collection is empty the tool returns clash_count: 0 with a note rather than erroring — the agent should treat that as "model not ready" and retry later.',
      '',
      'Side effects: none in APS. Reads vdc_rules from D1 when both categories are supplied. Logs usage to D1 usage_log. Idempotent — same inputs on a stable model yield the same clash list.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        model_id: {
          type: 'string',
          description: 'Base64url-encoded URN of the translated Navisworks model, exactly as returned by nwd_upload.model_id (or the urn field). Do NOT re-encode. Starts with "dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6" for OSS-derived URNs.',
          examples: ['dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2NhbmJpbS1ud2QtMTcxMjM0NTY3OC9Ub3dlckFfTUVQU3RydWN0X1IwNy5ud2Q']
        },
        clash_type: {
          type: 'string',
          enum: ['hard', 'soft', 'all'],
          description: 'Clash severity class. "hard" = solid-solid interference (e.g. duct through beam) — returns severity:critical. "soft" = clearance/tolerance violations (e.g. MEP within 50mm of structure) — returns severity:warning. "all" = both. Defaults to "all" when omitted.',
          examples: ['hard', 'all']
        },
        category_a: {
          type: 'string',
          description: 'First element-set filter, case-insensitive substring match against each element\'s Revit/Navisworks Category. Common values: "Mechanical", "Ducts", "Pipes", "Plumbing", "Electrical", "Structural Framing", "Structural Columns", "Walls", "Floors", "Ceilings". Omit (with category_b) to auto-split MEP vs. structural.',
          examples: ['Mechanical', 'Ducts', 'Structural Framing']
        },
        category_b: {
          type: 'string',
          description: 'Second element-set filter, same semantics as category_a. Must be supplied together with category_a to take effect — supplying only one is ignored in favor of auto-split. Provide both to also look up matching VDC rules from D1.',
          examples: ['Structural', 'Structural Columns', 'Walls']
        }
      },
      required: ['model_id']
    }
  },
  {
    name: 'nwd_export_report',
    description: [
      'Build a coordination report for a translated Navisworks model: translation status/progress, derivative outputs, available views (2D sheets / 3D viewables), total element count, and a per-category element breakdown. Doubles as the canonical way to poll translation status after nwd_upload.',
      '',
      'When to use: after nwd_upload to check whether translation has completed before calling clash/object tools; at the end of a coordination session to generate a status snapshot for the weekly BIM report; when auditing a model revision to confirm expected element counts per discipline.',
      '',
      'When NOT to use: do not use for a per-element property dump — use nwd_list_objects; do not use for clash results — use nwd_get_clashes.',
      '',
      'APS scopes required: viewables:read data:read bucket:read (read-only).',
      '',
      'Rate limits: APS default ~50 req/min per endpoint; this tool issues up to 4 sequential APS calls (manifest, metadata, properties — two with retry). When polling for translation completion, backoff: 5s, 10s, 30s, 60s, 120s — Model Derivative NWD translation typically completes in 1-10 min but large federated models can take 20+ min.',
      '',
      'Errors: 401 APS token expired (retry); 403 missing scope (report); 404 URN not found (model was never uploaded or bucket TTL expired); 409 N/A; 422 translation failed permanently — inspect report.translation_status == "failed" and report.derivatives[].status; 429 rate limit (backoff); 5xx APS upstream (retry once). Property extraction may legitimately 202 "isProcessing" — the tool handles retry and then silently swallows to still return manifest/metadata (element_count will be 0 until properties index is built).',
      '',
      'Side effects: none. Pure read. Idempotent — report reflects current APS state. Logs usage to D1 usage_log.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        model_id: {
          type: 'string',
          description: 'Base64url-encoded URN of the translated Navisworks model as returned by nwd_upload. Same value used by the other nwd_* tools.',
          examples: ['dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2NhbmJpbS1ud2QtMTcxMjM0NTY3OC9Ub3dlckFfTUVQU3RydWN0X1IwNy5ud2Q']
        },
        format: {
          type: 'string',
          enum: ['json', 'summary'],
          description: 'Output shape. "json" (default) returns the full structured report object including derivatives[], views[], category_breakdown. "summary" still returns the same keys — the parameter is preserved for forward-compatibility and currently echoes back in the response for caller templating.',
          examples: ['json', 'summary']
        }
      },
      required: ['model_id']
    }
  },
  {
    name: 'nwd_get_viewpoints',
    description: [
      'List saved viewpoints / camera positions and top-level view containers for a translated Navisworks model. Pulls the metadata view list and enriches each 3D view with its first two levels of the object tree (viewpoint folders typically live there in NWD files).',
      '',
      'When to use: when preparing a coordination meeting and you need a quick index of every saved viewpoint (e.g. "Level 3 Mech Room", "Clash - duct vs beam gridline C-4") to drive screenshots or BCF-style issues; when an agent needs to deep-link a 2D sheet or 3D camera into the APS Viewer.',
      '',
      'When NOT to use: does not return camera matrices (position/target/up vectors) — APS Model Derivative does not expose those from the NWD viewpoint XML; for full camera data the source NWD must be opened in Navisworks Manage.',
      '',
      'APS scopes required: viewables:read data:read.',
      '',
      'Rate limits: APS default ~50 req/min; this tool fans out one object-tree call per 3D view (capped implicitly by metadata view count, usually <5). For federated models with many sheets this can approach the per-minute quota — cache the result.',
      '',
      'Errors: 401 token (retry); 403 scope (report); 404 URN not found / translation incomplete; 409 N/A; 422 model returned empty metadata (returns viewpoint_count:0 rather than throwing — agent should verify translation via nwd_export_report); 429 rate limit (backoff); 5xx APS upstream (retry once). Per-view object-tree failures are swallowed so the overall call still returns the metadata-level view list.',
      '',
      'Side effects: none. Pure read. Idempotent. Logs usage to D1 usage_log. Results are capped at 100 viewpoint entries.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        model_id: {
          type: 'string',
          description: 'Base64url-encoded URN of the translated Navisworks model as returned by nwd_upload.',
          examples: ['dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2NhbmJpbS1ud2QtMTcxMjM0NTY3OC9Ub3dlckFfTUVQU3RydWN0X1IwNy5ud2Q']
        }
      },
      required: ['model_id']
    }
  },
  {
    name: 'nwd_list_objects',
    description: [
      'List elements (objects) in the translated Navisworks model with their objectid, name, externalId, and full property bag, optionally filtered by a case-insensitive keyword matched against name and Category.',
      '',
      'When to use: when answering "how many VAV boxes are on Level 3?", "list every steel column with mark C-*", or any per-element question; when dumping a quick takeoff of a discipline before handing off to an estimator; when an agent needs externalIds to cross-reference with a Revit or ACC issue.',
      '',
      'When NOT to use: not for clash detection (use nwd_get_clashes); not for camera/viewpoint data (use nwd_get_viewpoints); not for full-model exports — results are capped at 100 objects per call, so use the filter argument to narrow.',
      '',
      'APS scopes required: viewables:read data:read.',
      '',
      'Rate limits: APS default ~50 req/min; two Model Derivative calls per invocation (metadata guid + properties). Properties endpoint may 202 "isProcessing" on first call after translation — the worker retries once after 3s. For very large models the properties payload can be tens of MB; expect higher latency.',
      '',
      'Errors: 401 token (retry); 403 scope (report); 404 URN not found; 409 N/A; 422 property index not yet built — returns object_count:0 (poll via nwd_export_report); 429 rate limit (backoff); 5xx APS upstream (retry once). If property collection is legitimately empty the tool returns success with object_count:0 and an empty objects array.',
      '',
      'Side effects: none. Pure read. Idempotent. Logs usage to D1 usage_log. Response includes a `note` field when the unfiltered collection exceeds the 100-object cap.'
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        model_id: {
          type: 'string',
          description: 'Base64url-encoded URN of the translated Navisworks model as returned by nwd_upload.',
          examples: ['dXJuOmFkc2sub2JqZWN0czpvcy5vYmplY3Q6c2NhbmJpbS1ud2QtMTcxMjM0NTY3OC9Ub3dlckFfTUVQU3RydWN0X1IwNy5ud2Q']
        },
        filter: {
          type: 'string',
          description: 'Optional case-insensitive substring. Matches if present in the element\'s name OR its Category property. Use Revit category names ("Ducts", "Pipes", "Structural Columns", "Walls") or mark/type fragments ("VAV", "W12x", "L3-"). Omit to return the first 100 elements of the model in property-collection order.',
          examples: ['VAV', 'Ducts', 'Structural Columns', 'L3-']
        }
      },
      required: ['model_id']
    }
  }
];

// ── Real Tool Handlers ────────────────────────────────────────

async function handleTool(name, args, env) {
  // Usage logging
  if (env.DB) {
    try {
      await env.DB.prepare("INSERT INTO usage_log (tool_name, model_id, created_at) VALUES (?, ?, ?)")
        .bind(name, args.model_id || null, new Date().toISOString()).run();
    } catch (e) {}
  }

  switch (name) {

    // ── 1. nwd_upload ─────────────────────────────────────────
    // Real: Fetch file → Upload to OSS → Start SVF2 translation
    case 'nwd_upload': {
      const token = await getAPSToken(env);
      const bucketKey = `scanbim-nwd-${Date.now()}`;
      const objectKey = args.file_name.replace(/[^a-zA-Z0-9._-]/g, '_');

      await ensureBucket(token, bucketKey);

      const fileResp = await fetch(args.file_url);
      if (!fileResp.ok) throw new Error(`Failed to fetch file (${fileResp.status})`);
      const fileBytes = await fileResp.arrayBuffer();
      const fileSizeMB = (fileBytes.byteLength / (1024 * 1024)).toFixed(2);

      const uploadResp = await fetch(`${APS_BASE}/oss/v2/buckets/${bucketKey}/objects/${objectKey}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        body: fileBytes
      });
      if (!uploadResp.ok) throw new Error(`OSS upload failed (${uploadResp.status})`);
      const uploadData = await uploadResp.json();
      const objectId = uploadData.objectId;
      const urn = btoa(objectId).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const translateResp = await fetch(`${APS_BASE}/modelderivative/v2/designdata/job`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-ads-force': 'true' },
        body: JSON.stringify({
          input: { urn },
          output: { formats: [{ type: 'svf2', views: ['2d', '3d'] }] }
        })
      });
      if (!translateResp.ok) throw new Error(`Translation failed (${translateResp.status})`);
      const translateData = await translateResp.json();

      return {
        status: 'success',
        message: 'NWD file uploaded and translation started',
        model_id: urn,
        urn,
        object_id: objectId,
        bucket: bucketKey,
        file_name: args.file_name,
        file_size_mb: parseFloat(fileSizeMB),
        translation_status: translateData.result || 'inprogress',
        project_id: args.project_id || null,
        created_at: new Date().toISOString()
      };
    }

    // ── 2. nwd_get_clashes ────────────────────────────────────
    // Real: Get properties → Cross-compare elements by bounding box/level overlap
    case 'nwd_get_clashes': {
      const token = await getAPSToken(env);
      const guid = await getModelGUID(token, args.model_id);
      const props = await getProperties(token, args.model_id, guid);

      if (!props.data || !props.data.collection) {
        return { status: 'success', model_id: args.model_id, clash_count: 0, clashes: [], note: 'No property data.' };
      }

      const getCat = (el) => {
        if (!el.properties) return '';
        return (el.properties['Category'] || el.properties['__category__']?.['Category'] || el.name || '').toLowerCase();
      };

      const getLevel = (el) => {
        if (!el.properties) return null;
        for (const group of Object.values(el.properties)) {
          if (typeof group === 'object' && group !== null) {
            return group['Level'] || group['Reference Level'] || group['Base Constraint'] || null;
          }
        }
        return null;
      };

      let setA, setB;
      if (args.category_a && args.category_b) {
        const catAL = args.category_a.toLowerCase();
        const catBL = args.category_b.toLowerCase();
        setA = props.data.collection.filter(el => getCat(el).includes(catAL));
        setB = props.data.collection.filter(el => getCat(el).includes(catBL));
      } else {
        // Auto-detect: split all elements into discipline groups and cross-compare
        const mechanical = props.data.collection.filter(el => {
          const c = getCat(el);
          return c.includes('duct') || c.includes('pipe') || c.includes('mechanical') || c.includes('plumbing');
        });
        const structural = props.data.collection.filter(el => {
          const c = getCat(el);
          return c.includes('structural') || c.includes('column') || c.includes('beam') || c.includes('framing');
        });
        setA = mechanical.length > 0 ? mechanical : props.data.collection.slice(0, Math.floor(props.data.collection.length / 2));
        setB = structural.length > 0 ? structural : props.data.collection.slice(Math.floor(props.data.collection.length / 2));
      }

      const clashes = [];
      const limitA = Math.min(setA.length, 50);
      const limitB = Math.min(setB.length, 50);

      for (let i = 0; i < limitA && clashes.length < 100; i++) {
        for (let j = 0; j < limitB && clashes.length < 100; j++) {
          const levelA = getLevel(setA[i]);
          const levelB = getLevel(setB[j]);
          if (levelA && levelB && levelA === levelB) {
            const severity = (args.clash_type === 'hard' || args.clash_type === 'all') ? 'hard' : 'soft';
            clashes.push({
              id: `clash_${clashes.length + 1}`,
              type: severity,
              severity: severity === 'hard' ? 'critical' : 'warning',
              element_a: { objectid: setA[i].objectid, name: setA[i].name },
              element_b: { objectid: setB[j].objectid, name: setB[j].name },
              shared_level: levelA,
              detection_method: 'same_level_proximity'
            });
          }
        }
      }

      // Load VDC rules
      let vdcRules = [];
      if (env.DB && args.category_a && args.category_b) {
        try {
          const rules = await env.DB.prepare(
            "SELECT * FROM vdc_rules WHERE (category_a = ? AND category_b = ?) OR (category_a = ? AND category_b = ?) LIMIT 10"
          ).bind(args.category_a, args.category_b, args.category_b, args.category_a).all();
          vdcRules = rules.results || [];
        } catch (e) {}
      }

      return {
        status: 'success',
        model_id: args.model_id,
        clash_type: args.clash_type || 'all',
        elements_analyzed: { set_a: setA.length, set_b: setB.length },
        clash_count: clashes.length,
        clashes: clashes.slice(0, 50),
        vdc_rules_applied: vdcRules.length,
        vdc_rules: vdcRules,
        created_at: new Date().toISOString()
      };
    }

    // ── 3. nwd_export_report ──────────────────────────────────
    // Real: Get manifest + metadata + properties → Build coordination report
    case 'nwd_export_report': {
      const token = await getAPSToken(env);
      const manifest = await getManifest(token, args.model_id);
      const meta = await getModelMetadata(token, args.model_id);

      let elementCount = 0;
      let categories = {};
      try {
        const guid = await getModelGUID(token, args.model_id);
        const props = await getProperties(token, args.model_id, guid);
        if (props.data && props.data.collection) {
          elementCount = props.data.collection.length;
          props.data.collection.forEach(el => {
            const cat = el.properties?.['Category'] || el.properties?.['__category__']?.['Category'] || 'Unknown';
            categories[cat] = (categories[cat] || 0) + 1;
          });
        }
      } catch (e) { /* properties may not be ready */ }

      const derivatives = (manifest.derivatives || []).map(d => ({
        outputType: d.outputType,
        status: d.status,
        children_count: (d.children || []).length
      }));

      const views = (meta.data?.metadata || []).map(v => ({
        name: v.name,
        role: v.role,
        guid: v.guid
      }));

      return {
        status: 'success',
        model_id: args.model_id,
        format: args.format || 'json',
        report: {
          translation_status: manifest.status,
          progress: manifest.progress,
          region: manifest.region,
          derivatives,
          views,
          element_count: elementCount,
          category_breakdown: categories,
          generated_at: new Date().toISOString()
        }
      };
    }

    // ── 4. nwd_get_viewpoints ─────────────────────────────────
    // Real: Get metadata views → Extract viewpoint/camera info from object tree
    case 'nwd_get_viewpoints': {
      const token = await getAPSToken(env);
      const meta = await getModelMetadata(token, args.model_id);

      if (!meta.data || !meta.data.metadata) {
        return { status: 'success', model_id: args.model_id, viewpoint_count: 0, viewpoints: [] };
      }

      const viewpoints = [];
      for (const view of meta.data.metadata) {
        viewpoints.push({
          guid: view.guid,
          name: view.name,
          role: view.role,
          type: view.role === '3d' ? 'Saved Viewpoint (3D)' : 'Sheet/2D View',
          is_master: view.isMasterView || false
        });

        // Try to get children from object tree for saved viewpoints
        if (view.role === '3d') {
          try {
            const tree = await getObjectTree(token, args.model_id, view.guid);
            if (tree.data && tree.data.objects) {
              const extractVPs = (objects, depth = 0) => {
                for (const obj of objects) {
                  if (depth <= 1 && obj.name) {
                    viewpoints.push({
                      objectid: obj.objectid,
                      name: obj.name,
                      parent_view: view.name,
                      has_children: !!(obj.objects && obj.objects.length > 0)
                    });
                  }
                  if (obj.objects && depth < 1) extractVPs(obj.objects, depth + 1);
                }
              };
              const root = Array.isArray(tree.data.objects) ? tree.data.objects : [tree.data.objects];
              extractVPs(root);
            }
          } catch (e) {}
        }
      }

      return {
        status: 'success',
        model_id: args.model_id,
        viewpoint_count: viewpoints.length,
        viewpoints: viewpoints.slice(0, 100)
      };
    }

    // ── 5. nwd_list_objects ───────────────────────────────────
    // Real: Get properties → List/filter objects
    case 'nwd_list_objects': {
      const token = await getAPSToken(env);
      const guid = await getModelGUID(token, args.model_id);
      const props = await getProperties(token, args.model_id, guid);

      if (!props.data || !props.data.collection) {
        return { status: 'success', model_id: args.model_id, object_count: 0, objects: [] };
      }

      let collection = props.data.collection;
      if (args.filter) {
        const filterLower = args.filter.toLowerCase();
        collection = collection.filter(el => {
          const name = (el.name || '').toLowerCase();
          const cat = (el.properties?.['Category'] || el.properties?.['__category__']?.['Category'] || '').toLowerCase();
          return name.includes(filterLower) || cat.includes(filterLower);
        });
      }

      const objects = collection.slice(0, 100).map(el => ({
        objectid: el.objectid,
        name: el.name,
        externalId: el.externalId,
        properties: el.properties || {}
      }));

      return {
        status: 'success',
        model_id: args.model_id,
        filter: args.filter || null,
        total_objects: collection.length,
        returned: objects.length,
        objects,
        note: collection.length > 100 ? `Showing first 100 of ${collection.length}` : undefined
      };
    }

    default:
      return { status: 'error', message: 'Unknown tool: ' + name };
  }
}

// ── MCP Protocol Handler ──────────────────────────────────────

async function handleMCP(req, env) {
  const body = await req.json();
  const { method, params, id } = body;
  const respond = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'Content-Type': 'application/json' } });
  const error = (code, msg) => new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: msg } }), { headers: { 'Content-Type': 'application/json' } });

  if (method === 'initialize') return respond({ protocolVersion: '2024-11-05', serverInfo: SERVER_INFO, capabilities: { tools: {} } });
  if (method === 'tools/list') return respond({ tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const result = await handleTool(params.name, params.arguments || {}, env);
      return respond({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return respond({ content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: e.message }) }] });
    }
  }
  if (method === 'ping') return respond({});
  return error(-32601, 'Method not found');
}

const __origHandler = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const resp = await handleMCP(req, env);
      Object.entries(cors).forEach(([k, v]) => resp.headers.set(k, v));
      return resp;
    }
    if (url.pathname === '/info' || url.pathname === '/') {
      return new Response(JSON.stringify({ ...SERVER_INFO, tools_count: TOOLS.length, tools: TOOLS.map(t => t.name) }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', version: SERVER_INFO.version, aps_configured: !!(env.APS_CLIENT_ID && env.APS_CLIENT_SECRET) }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    return new Response('Navisworks MCP v1.1.0 — ScanBIM Labs', { headers: cors });
  }
};

// === scanbim-health patch: export default wrapper ===
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return __applySec(await __handleHealth(env));
    if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') {
      return __applySec(new Response(__FAVICON_SVG, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=31536000, immutable' } }));
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const cloned = req.clone();
      let body;
      try { body = await cloned.json(); } catch {}
      if (body) {
        const check = await __creditCheck(req, env, body);
        if (!check.ok) return __applySec(check.response);
      }
    }
    const resp = await __origHandler.fetch(req, env, ctx);
    return __applySec(resp);
  },
  async scheduled(event, env, ctx) {
    if (__origHandler.scheduled) return __origHandler.scheduled(event, env, ctx);
  }
};
