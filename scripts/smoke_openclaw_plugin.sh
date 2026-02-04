#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"

log() {
  echo "[smoke_openclaw] $*"
}

die() {
  echo "[smoke_openclaw] ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

pick_free_port() {
  node -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});'
}

json_get() {
  local json="$1"
  local path="$2"
  printf '%s' "$json" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += String(d)));
    process.stdin.on("end", () => {
      const j = JSON.parse(s || "{}");
      const path = process.argv[1];
      let cur = j;
      for (const part of String(path || "").split(".")) {
        if (cur == null) break;
        const m = part.match(/^(.+)\[(\d+)\]$/);
        if (m) {
          cur = cur?.[m[1]];
          cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined;
          continue;
        }
        cur = cur?.[part];
      }
      if (cur === undefined || cur === null) process.exit(1);
      process.stdout.write(typeof cur === "string" ? cur : JSON.stringify(cur));
    });
  ' "$path"
}

curl_json_checked() {
  local method="$1"
  local url="$2"
  shift 2

  local tmp
  tmp="$(mktemp)"
  local code
  code="$(curl -sS -o "$tmp" -w "%{http_code}" -X "$method" -H "content-type: application/json" "$url" "$@")"
  local body
  body="$(cat "$tmp")"
  rm -f "$tmp"
  if [[ "$code" -ge 200 && "$code" -lt 300 ]]; then
    echo "$body"
    return 0
  fi
  die "HTTP $code $method $url: ${body:0:2000}"
}

wait_http_ok() {
  local url="$1"
  local timeout_sec="${2:-60}"
  local deadline=$((SECONDS + timeout_sec))
  while (( SECONDS < deadline )); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

wait_file() {
  local file="$1"
  local timeout_sec="${2:-60}"
  local deadline=$((SECONDS + timeout_sec))
  while (( SECONDS < deadline )); do
    if [[ -f "$file" ]]; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

wait_openclaw_health() {
  local url="$1"
  local token="$2"
  local timeout_sec="${3:-60}"
  local deadline=$((SECONDS + timeout_sec))
  while (( SECONDS < deadline )); do
    if "$OPENCLAW_BIN" gateway call health --url "$url" --token "$token" --json >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

ts_suffix() {
  date -u +"%Y%m%d%H%M%S"
}

require_cmd docker
require_cmd node
require_cmd curl

if [[ "$OPENCLAW_BIN" == */* ]]; then
  [[ -f "$OPENCLAW_BIN" ]] || die "OPENCLAW_BIN not found: $OPENCLAW_BIN"
  [[ -x "$OPENCLAW_BIN" ]] || die "OPENCLAW_BIN is not executable: $OPENCLAW_BIN"
else
  require_cmd "$OPENCLAW_BIN"
fi

SMOKE_ID="openclaw_$(ts_suffix)"
SMOKE_DIR="$ROOT_DIR/var/smoke/$SMOKE_ID"
LOG_DIR="$SMOKE_DIR/logs"
mkdir -p "$LOG_DIR"

PW_PORT="$(pick_free_port)"
SITE_PORT="$(pick_free_port)"
GW_PORT="$(pick_free_port)"

BASE_URL="http://127.0.0.1:${PW_PORT}"
SITE_ORIGIN="http://127.0.0.1:${SITE_PORT}"
GW_URL="ws://127.0.0.1:${GW_PORT}"
GW_TOKEN="gw_${SMOKE_ID}_$(node -e 'console.log(Math.random().toString(16).slice(2))')"

PW_LOG="$LOG_DIR/proofwork.log"
SITE_LOG="$LOG_DIR/site.log"
GW_LOG="$LOG_DIR/openclaw_gateway.log"

OPENCLAW_STATE_DIR="$SMOKE_DIR/openclaw_state"
OPENCLAW_WORKSPACE="$SMOKE_DIR/openclaw_workspace"
export OPENCLAW_STATE_DIR

DB_NAME="proofwork_smoke_${SMOKE_ID}"
KEEP_DB="${KEEP_DB:-0}"

cleanup() {
  set +e
  log "cleanup..."

  if [[ -n "${GATEWAY_PID:-}" ]]; then
    if [[ -n "${BROWSER_PROFILE:-}" ]]; then
      "$OPENCLAW_BIN" browser --url "$GW_URL" --token "$GW_TOKEN" --browser-profile "$BROWSER_PROFILE" stop --json >/dev/null 2>&1 || true
    fi
    kill "$GATEWAY_PID" >/dev/null 2>&1 || true
    wait "$GATEWAY_PID" >/dev/null 2>&1 || true
  fi

  if [[ -n "${SITE_PID:-}" ]]; then
    kill "$SITE_PID" >/dev/null 2>&1 || true
    wait "$SITE_PID" >/dev/null 2>&1 || true
  fi

  if [[ -n "${PW_PID:-}" ]]; then
    kill "$PW_PID" >/dev/null 2>&1 || true
    wait "$PW_PID" >/dev/null 2>&1 || true
  fi

  if [[ "$KEEP_DB" == "1" ]]; then
    log "KEEP_DB=1; leaving database ${DB_NAME}"
  else
    docker compose exec -T postgres psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS ${DB_NAME};" >/dev/null 2>&1 || true
  fi

  log "cleanup done (logs at $LOG_DIR)"
}
trap cleanup EXIT

log "starting docker postgres..."
docker compose up -d postgres >/dev/null

log "creating smoke db: $DB_NAME"
docker compose exec -T postgres psql -U postgres -d postgres -c "CREATE DATABASE ${DB_NAME};" >/dev/null

export DATABASE_URL="postgresql://postgres:postgres@localhost:5433/${DB_NAME}"
export STORAGE_BACKEND="local"
export STORAGE_LOCAL_DIR="$SMOKE_DIR/uploads"
export PUBLIC_BASE_URL="$BASE_URL"
export ENABLE_DEMO_SEED="false"
export ENABLE_TASK_DESCRIPTOR="true"
export SCANNER_ENGINE="basic"
export ADMIN_TOKEN="pw_adm_internal"
export VERIFIER_TOKEN="pw_vf_internal"
export WORKER_TOKEN_PEPPER="dev_pepper_change_me"
export BUYER_TOKEN_PEPPER="dev_pepper_change_me"
export SESSION_SECRET="dev_session_secret_change_me"

log "starting Proofwork API on $BASE_URL ..."
PORT="$PW_PORT" npm run -s dev >"$PW_LOG" 2>&1 &
PW_PID=$!

log "waiting for Proofwork /health ..."
wait_http_ok "$BASE_URL/health" 60 || die "Proofwork API did not become healthy (see $PW_LOG)"

SITE_TOKEN_FILE="$SMOKE_DIR/site_verify_token.txt"
echo "" >"$SITE_TOKEN_FILE"

log "starting local origin server on $SITE_ORIGIN (verification token file: $SITE_TOKEN_FILE) ..."
node - "$SITE_PORT" "$SITE_TOKEN_FILE" >"$SITE_LOG" 2>&1 <<'NODE' &
const http = require("http");
const fs = require("fs");

const port = Number(process.argv[2]);
const tokenFile = String(process.argv[3] ?? "");
if (!Number.isFinite(port) || port <= 0) throw new Error("invalid_port");
if (!tokenFile) throw new Error("missing_token_file");

function currentToken() {
  try {
    return String(fs.readFileSync(tokenFile, "utf8") ?? "").trim();
  } catch {
    return "";
  }
}

const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"/><title>Proofwork OpenClaw Smoke</title></head>
  <body>
    <h1>Proofwork OpenClaw Smoke</h1>
    <label for="q">Query</label>
    <input id="q" aria-label="Query" />
    <button id="go">Go</button>
    <div id="status" aria-label="Status"></div>
    <script>
      document.getElementById("go").addEventListener("click", () => {
        document.getElementById("status").textContent = "Done";
      });
    </script>
  </body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

  // Origin verification (header method): Proofwork checks HEAD / and expects X-Proofwork-Verify.
  if (url.pathname === "/" && req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("x-proofwork-verify", currentToken());
    res.end();
    return;
  }

  // Optional: http_file method support.
  if (url.pathname === "/.well-known/proofwork-verify.txt" && req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`${currentToken()}\n`);
    return;
  }

  if ((url.pathname === "/" || url.pathname === "/task") && req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }

  res.statusCode = 404;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end("not found\n");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[site] listening on http://127.0.0.1:${port}`);
});
NODE
SITE_PID=$!

wait_http_ok "$SITE_ORIGIN/task" 30 || die "origin server did not start (see $SITE_LOG)"

log "registering org..."
ORG_EMAIL="smoke+${SMOKE_ID}@example.com"
ORG_PASSWORD="pw_${SMOKE_ID}_demo"
ORG_JSON="$(curl_json_checked POST "$BASE_URL/api/org/register" -d "$(node -e 'console.log(JSON.stringify({orgName:process.argv[1],email:process.argv[2],password:process.argv[3],apiKeyName:"default"}))' "Smoke ${SMOKE_ID}" "$ORG_EMAIL" "$ORG_PASSWORD")")"
BUYER_TOKEN="$(json_get "$ORG_JSON" "token")"
ORG_ID="$(json_get "$ORG_JSON" "orgId")"
[[ -n "$BUYER_TOKEN" ]] || die "org register missing token"
[[ -n "$ORG_ID" ]] || die "org register missing orgId"

log "admin top-up so we can publish bounties..."
curl_json_checked POST "$BASE_URL/api/admin/billing/orgs/${ORG_ID}/topup" \
  -H "authorization: Bearer ${ADMIN_TOKEN}" \
  -d '{"amountCents":50000}' >/dev/null

log "verifying origin for org: $SITE_ORIGIN"
ORIGIN_CREATE_JSON="$(curl_json_checked POST "$BASE_URL/api/origins" -H "authorization: Bearer ${BUYER_TOKEN}" -d "$(node -e 'console.log(JSON.stringify({origin:process.argv[1],method:"header"}))' "$SITE_ORIGIN")")"
ORIGIN_ID="$(json_get "$ORIGIN_CREATE_JSON" "origin.id")"
ORIGIN_TOKEN="$(json_get "$ORIGIN_CREATE_JSON" "origin.token" || true)"
[[ -n "$ORIGIN_ID" ]] || die "origin create missing id"
[[ -n "$ORIGIN_TOKEN" ]] || die "origin create missing token"
echo "$ORIGIN_TOKEN" >"$SITE_TOKEN_FILE"

for _ in {1..40}; do
  ORIGIN_CHECK_JSON="$(curl_json_checked POST "$BASE_URL/api/origins/${ORIGIN_ID}/check" -H "authorization: Bearer ${BUYER_TOKEN}")"
  ORIGIN_STATUS="$(json_get "$ORIGIN_CHECK_JSON" "origin.status" || true)"
  if [[ "$ORIGIN_STATUS" == "verified" ]]; then
    break
  fi
  sleep 0.5
done
if [[ "${ORIGIN_STATUS:-}" != "verified" ]]; then
  ORIGIN_FAIL_REASON="$(json_get "${ORIGIN_CHECK_JSON:-$ORIGIN_CREATE_JSON}" "origin.failureReason" 2>/dev/null || true)"
  die "origin not verified: status=${ORIGIN_STATUS:-unknown} reason=${ORIGIN_FAIL_REASON:-}"
fi

SMOKE_TASK_TYPE="smoke_openclaw_${SMOKE_ID}"
APP_SLUG="smoke-${SMOKE_ID//_/-}"

log "registering app/task type: $SMOKE_TASK_TYPE"
curl_json_checked POST "$BASE_URL/api/org/apps" \
  -H "authorization: Bearer ${BUYER_TOKEN}" \
  -d "$(node -e 'console.log(JSON.stringify({slug:process.argv[1],taskType:process.argv[2],name:"Smoke App",description:"auto-created by smoke_openclaw_plugin.sh",public:false}))' "$APP_SLUG" "$SMOKE_TASK_TYPE")" >/dev/null

log "bootstrapping OpenClaw state under $OPENCLAW_STATE_DIR ..."
mkdir -p "$OPENCLAW_WORKSPACE"
"$OPENCLAW_BIN" onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice skip \
  --skip-channels \
  --skip-skills \
  --skip-health \
  --skip-ui \
  --mode local \
  --workspace "$OPENCLAW_WORKSPACE" \
  --gateway-auth token \
  --gateway-port "$GW_PORT" \
  --gateway-token "$GW_TOKEN" >/dev/null

PLUGIN_DIR="$ROOT_DIR/integrations/openclaw/extensions/proofwork-worker"
BROWSER_PROFILE="proofwork-worker-smoke"

log "configuring OpenClaw plugin load-by-path..."
PATHS_JSON="$(node -e 'console.log(JSON.stringify([process.argv[1]]))' "$PLUGIN_DIR")"
PLUGIN_CONFIG_JSON="$(node -e '
  const apiBaseUrl = process.argv[1];
  const openclawBin = process.argv[2];
  const browserProfile = process.argv[3];
  const requireTaskType = process.argv[4];
  const cfg = {
    apiBaseUrl,
    openclawBin,
    browserProfile,
    supportedCapabilityTags: ["browser","screenshot","http","llm_summarize"],
    pollIntervalMs: 750,
    requireTaskType,
    originEnforcement: "strict",
    noLogin: true,
    valueEnvAllowlist: [],
    canaryPercent: 100,
    logLevel: "info",
  };
  console.log(JSON.stringify(cfg));
' "$BASE_URL" "$OPENCLAW_BIN" "$BROWSER_PROFILE" "$SMOKE_TASK_TYPE")"

# Toggle off while setting to avoid config warnings from intermediate states.
"$OPENCLAW_BIN" config set --json plugins.enabled false >/dev/null || true
"$OPENCLAW_BIN" config set --json plugins.load.paths "$PATHS_JSON" >/dev/null
"$OPENCLAW_BIN" config set --json plugins.entries.proofwork-worker.config "$PLUGIN_CONFIG_JSON" >/dev/null
"$OPENCLAW_BIN" config set --json plugins.entries.proofwork-worker.enabled true >/dev/null
"$OPENCLAW_BIN" config set --json plugins.enabled true >/dev/null

log "starting OpenClaw Gateway on $GW_URL ..."
"$OPENCLAW_BIN" gateway run --port "$GW_PORT" --token "$GW_TOKEN" --bind loopback --verbose >"$GW_LOG" 2>&1 &
GATEWAY_PID=$!

log "waiting for OpenClaw gateway health..."
wait_openclaw_health "$GW_URL" "$GW_TOKEN" 60 || die "OpenClaw gateway did not become healthy (see $GW_LOG)"

log "creating browser profile + starting browser: $BROWSER_PROFILE"
"$OPENCLAW_BIN" browser --url "$GW_URL" --token "$GW_TOKEN" create-profile --name "$BROWSER_PROFILE" --json >/dev/null 2>&1 || true
"$OPENCLAW_BIN" browser --url "$GW_URL" --token "$GW_TOKEN" --browser-profile "$BROWSER_PROFILE" start --json >/dev/null

log "checking plugin discovery..."
"$OPENCLAW_BIN" plugins list --json | node -e '
  let s="";process.stdin.on("data",d=>s+=String(d));
  process.stdin.on("end",()=>{const j=JSON.parse(s||"{}");const ok=Array.isArray(j.plugins)&&j.plugins.some((p)=>p&&p.id==="proofwork-worker");process.exit(ok?0:1);});
' || die "plugin not discovered (plugins list --json)"

WORKSPACE_HASH="$(node -e 'const {createHash}=require("crypto");const path=require("path");const ws=path.resolve(process.argv[1]);process.stdout.write(createHash("sha256").update(ws).digest("hex").slice(0,12));' "$OPENCLAW_WORKSPACE")"
PLUGIN_STATE_ROOT="$OPENCLAW_STATE_DIR/plugins/proofwork-worker/$WORKSPACE_HASH"
TOKEN_FILE="$PLUGIN_STATE_ROOT/worker-token.json"
STATUS_FILE="$PLUGIN_STATE_ROOT/status.json"

log "waiting for worker token persistence file..."
wait_file "$TOKEN_FILE" 90 || die "token file not created (expected $TOKEN_FILE; see $GW_LOG)"

log "creating + publishing bounties (3 invalid + 1 valid)..."
create_bounty() {
  local title="$1"
  local payout="$2"
  local descriptor_json="$3"
  local bounty_json
  bounty_json="$(curl_json_checked POST "$BASE_URL/api/bounties" \
    -H "authorization: Bearer ${BUYER_TOKEN}" \
    -d "$(node -e 'console.log(JSON.stringify({title:process.argv[1],description:"smoke bounty",allowedOrigins:[process.argv[2]],requiredProofs:1,fingerprintClassesRequired:["desktop_us"],payoutCents:Number(process.argv[3]),taskDescriptor:JSON.parse(process.argv[4])}))' "$title" "$SITE_ORIGIN" "$payout" "$descriptor_json")")"
  local bounty_id
  bounty_id="$(json_get "$bounty_json" "id" || true)"
  [[ -n "$bounty_id" ]] || die "bounty create failed: $bounty_json"
  curl_json_checked POST "$BASE_URL/api/bounties/${bounty_id}/publish" -H "authorization: Bearer ${BUYER_TOKEN}" >/dev/null
  echo "$bounty_id"
}

DESC_BASE="$(node -e '
  const type = process.argv[1];
  const url = process.argv[2];
  const d = {
    schema_version: "v1",
    type,
    capability_tags: ["browser","screenshot"],
    input_spec: { url },
    output_spec: { required_artifacts: [ {kind:"screenshot", count:1}, {kind:"log", label:"report_summary"} ] },
    freshness_sla_sec: 3600,
    site_profile: { browser_flow: { steps: [] } }
  };
  console.log(JSON.stringify(d));
' "$SMOKE_TASK_TYPE" "$SITE_ORIGIN/task")"

DESC_ORIGIN_BAD="$(node -e 'const d=JSON.parse(process.argv[1]);d.site_profile.browser_flow.steps=[{op:"goto",url:"https://example.com"}];console.log(JSON.stringify(d));' "$DESC_BASE")"
DESC_LOGIN_BAD="$(node -e 'const d=JSON.parse(process.argv[1]);d.site_profile.browser_flow.steps=[{op:"fill",role:"textbox",name:"Password",value:"nope"}];console.log(JSON.stringify(d));' "$DESC_BASE")"
DESC_FN_BAD="$(node -e 'const d=JSON.parse(process.argv[1]);d.site_profile.browser_flow.steps=[{op:"extract",key:"x",ref:"1",fn:"() => 1"}];console.log(JSON.stringify(d));' "$DESC_BASE")"
DESC_OK="$(node -e '
  const d=JSON.parse(process.argv[1]);
  d.site_profile.browser_flow.steps=[
    {op:"fill",role:"textbox",name:"Query",value:"hello"},
    {op:"click",role:"button",name:"Go"},
    {op:"wait",text:"Done",timeout_ms:20000},
    {op:"screenshot",label:"after_done",full_page:true},
  ];
  console.log(JSON.stringify(d));
' "$DESC_BASE")"

BID_ORIGIN_BAD="$(create_bounty "Origin violation ${SMOKE_ID}" 3000 "$DESC_ORIGIN_BAD")"
BID_LOGIN_BAD="$(create_bounty "No-login violation ${SMOKE_ID}" 2500 "$DESC_LOGIN_BAD")"
BID_FN_BAD="$(create_bounty "extract.fn violation ${SMOKE_ID}" 2000 "$DESC_FN_BAD")"
BID_OK="$(create_bounty "Valid OpenClaw job ${SMOKE_ID}" 1500 "$DESC_OK")"

JOB_OK_JSON="$(curl_json_checked GET "$BASE_URL/api/bounties/${BID_OK}/jobs" -H "authorization: Bearer ${BUYER_TOKEN}")"
JOB_OK_ID="$(json_get "$JOB_OK_JSON" "jobs[0].id" || true)"
[[ -n "$JOB_OK_ID" ]] || die "missing job id for valid bounty: ${JOB_OK_JSON:0:2000}"

log "waiting for worker to claim + submit valid job: $JOB_OK_ID"
SUBMISSION_ID=""
deadline=$((SECONDS + 180))
while (( SECONDS < deadline )); do
  j="$(curl_json_checked GET "$BASE_URL/api/bounties/${BID_OK}/jobs" -H "authorization: Bearer ${BUYER_TOKEN}")"
  status="$(node -e 'const j=JSON.parse(process.argv[1]||"{}");const id=process.argv[2];const job=(j.jobs||[]).find(x=>String(x?.id??"")===id);process.stdout.write(String(job?.status??""));' "$j" "$JOB_OK_ID")"
  SUBMISSION_ID="$(node -e 'const j=JSON.parse(process.argv[1]||"{}");const id=process.argv[2];const job=(j.jobs||[]).find(x=>String(x?.id??"")===id);process.stdout.write(String(job?.currentSubmissionId??""));' "$j" "$JOB_OK_ID")"
  if [[ "$status" == "verifying" && -n "$SUBMISSION_ID" ]]; then
    break
  fi
  sleep 1
done
[[ -n "$SUBMISSION_ID" ]] || die "timeout waiting for submission (see $GW_LOG and $PW_LOG)"

log "verifier: claim + pass verdict for submission: $SUBMISSION_ID"
CLAIM_JSON="$(curl_json_checked POST "$BASE_URL/api/verifier/claim" \
  -H "authorization: Bearer ${VERIFIER_TOKEN}" \
  -d "$(node -e 'console.log(JSON.stringify({submissionId:process.argv[1],attemptNo:1,messageId:"m1",idempotencyKey:"idem1",verifierInstanceId:"smoke",claimTtlSec:600}))' "$SUBMISSION_ID")")"
CLAIM_TOKEN="$(json_get "$CLAIM_JSON" "claimToken")"
VERIFICATION_ID="$(json_get "$CLAIM_JSON" "verificationId")"

curl_json_checked POST "$BASE_URL/api/verifier/verdict" \
  -H "authorization: Bearer ${VERIFIER_TOKEN}" \
  -d "$(node -e '
    const submissionId = process.argv[1];
    const jobId = process.argv[2];
    const verificationId = process.argv[3];
    const claimToken = process.argv[4];
    console.log(JSON.stringify({
      verificationId,
      claimToken,
      submissionId,
      jobId,
      attemptNo: 1,
      verdict: "pass",
      reason: "smoke pass",
      scorecard: { R:1,E:1,A:1,N:1,T:1,qualityScore: 1 },
      evidenceArtifacts: []
    }));
  ' "$SUBMISSION_ID" "$JOB_OK_ID" "$VERIFICATION_ID" "$CLAIM_TOKEN")" >/dev/null

log "waiting for job done/pass..."
deadline=$((SECONDS + 60))
while (( SECONDS < deadline )); do
  j="$(curl_json_checked GET "$BASE_URL/api/bounties/${BID_OK}/jobs" -H "authorization: Bearer ${BUYER_TOKEN}")"
  status="$(node -e 'const j=JSON.parse(process.argv[1]||"{}");const id=process.argv[2];const job=(j.jobs||[]).find(x=>String(x?.id??"")===id);process.stdout.write(String(job?.status??""));' "$j" "$JOB_OK_ID")"
  verdict="$(node -e 'const j=JSON.parse(process.argv[1]||"{}");const id=process.argv[2];const job=(j.jobs||[]).find(x=>String(x?.id??"")===id);process.stdout.write(String(job?.finalVerdict??""));' "$j" "$JOB_OK_ID")"
  if [[ "$status" == "done" && "$verdict" == "pass" ]]; then
    break
  fi
  sleep 1
done
[[ "$status" == "done" && "$verdict" == "pass" ]] || die "timeout waiting for done/pass"

log "worker crash-restart check (kill worker pid and observe restart)..."
WORKER_PID_OLD="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.pid||""));' "$STATUS_FILE" 2>/dev/null || true)"
if [[ -n "$WORKER_PID_OLD" ]]; then
  kill "$WORKER_PID_OLD" >/dev/null 2>&1 || true
  deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    WORKER_PID_NEW="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.pid||""));' "$STATUS_FILE" 2>/dev/null || true)"
    if [[ -n "$WORKER_PID_NEW" && "$WORKER_PID_NEW" != "$WORKER_PID_OLD" ]]; then
      break
    fi
    sleep 1
  done
  [[ -n "${WORKER_PID_NEW:-}" && "$WORKER_PID_NEW" != "$WORKER_PID_OLD" ]] || die "worker did not restart after kill (see $GW_LOG)"
fi

log "token persistence check across gateway restart..."
TOK_HASH_1="$(shasum -a 256 "$TOKEN_FILE" | awk '{print $1}')"
WORKERS_1="$(docker compose exec -T postgres psql -U postgres -d "$DB_NAME" -Atc "select count(*) from workers;")"

kill "$GATEWAY_PID" >/dev/null 2>&1 || true
wait "$GATEWAY_PID" >/dev/null 2>&1 || true
unset GATEWAY_PID

"$OPENCLAW_BIN" gateway run --port "$GW_PORT" --token "$GW_TOKEN" --bind loopback --verbose >>"$GW_LOG" 2>&1 &
GATEWAY_PID=$!
wait_openclaw_health "$GW_URL" "$GW_TOKEN" 60 || die "gateway restart failed"

wait_file "$TOKEN_FILE" 30 || die "token file missing after gateway restart"
TOK_HASH_2="$(shasum -a 256 "$TOKEN_FILE" | awk '{print $1}')"
WORKERS_2="$(docker compose exec -T postgres psql -U postgres -d "$DB_NAME" -Atc "select count(*) from workers;")"

[[ "$TOK_HASH_1" == "$TOK_HASH_2" ]] || die "token file changed across restart (expected persistence)"
[[ "$WORKERS_1" == "$WORKERS_2" ]] || die "workers table count changed across restart (expected no re-register)"

log "token rotation check (delete token file -> expect new worker)..."
rm -f "$TOKEN_FILE"

kill "$GATEWAY_PID" >/dev/null 2>&1 || true
wait "$GATEWAY_PID" >/dev/null 2>&1 || true
unset GATEWAY_PID

"$OPENCLAW_BIN" gateway run --port "$GW_PORT" --token "$GW_TOKEN" --bind loopback --verbose >>"$GW_LOG" 2>&1 &
GATEWAY_PID=$!
wait_openclaw_health "$GW_URL" "$GW_TOKEN" 60 || die "gateway restart (rotation) failed"

wait_file "$TOKEN_FILE" 60 || die "token file not recreated after rotation"
WORKERS_3="$(docker compose exec -T postgres psql -U postgres -d "$DB_NAME" -Atc "select count(*) from workers;")"
if [[ "$WORKERS_3" -le "$WORKERS_2" ]]; then
  die "expected workers count to increase after token rotation (before=$WORKERS_2 after=$WORKERS_3)"
fi

log "OK"
