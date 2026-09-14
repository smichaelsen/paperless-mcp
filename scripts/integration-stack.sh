#!/usr/bin/env bash
#
# Bring up (and tear down) the disposable Paperless-ngx used by the integration
# test lane, and hand back the credentials the suite needs.
#
#   PAPERLESS_IT_VERSION=3.1.3 ./scripts/integration-stack.sh up
#   eval "$(./scripts/integration-stack.sh env)"   # local runs only
#   ./scripts/integration-stack.sh down
#
# CI and a laptop run this identical script, so a green local run and a green
# CI run mean the same thing.
#
# Readiness is the part worth reading. "The container is up" is not readiness
# for this suite: Paperless runs migrations at boot, creates the superuser
# after that, and starts a Celery worker that the upload test depends on. So
# `up` waits on three separate facts, each with its own bounded timeout and its
# own failure message, and dumps container logs when any of them times out:
#
#   1. compose reports both containers healthy (gunicorn is serving, which the
#      entrypoint only reaches after migrations finish);
#   2. POST /api/token/ returns a token (the superuser exists and auth works);
#   3. GET /api/status/ reports database, Redis and Celery all OK (the consumer
#      can actually process an upload).
#
# Nothing here sleeps for a fixed guess at how long a boot takes.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repo_root}/compose.integration.yaml"
env_file="${repo_root}/.paperless-it.env"

port="${PAPERLESS_IT_PORT:-8000}"
base_url="http://localhost:${port}"
admin_user="${PAPERLESS_IT_ADMIN_USER:-mcp-it-admin}"

# How long each phase may take before the script gives up and says why.
HEALTH_TIMEOUT="${PAPERLESS_IT_HEALTH_TIMEOUT:-420}"
TOKEN_TIMEOUT="${PAPERLESS_IT_TOKEN_TIMEOUT:-180}"
STATUS_TIMEOUT="${PAPERLESS_IT_STATUS_TIMEOUT:-180}"

die() {
  echo "integration-stack: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "required command '$1' is not installed"
}

compose() {
  docker compose -f "${compose_file}" "$@"
}

dump_logs() {
  echo "--- docker compose ps ---" >&2
  compose ps >&2 || true
  echo "--- paperless logs (tail 200) ---" >&2
  compose logs --tail 200 paperless >&2 || true
  echo "--- broker logs (tail 50) ---" >&2
  compose logs --tail 50 broker >&2 || true
}

# Emit a value into the GitHub Actions environment when running in CI, and
# always into the local env file. Secrets are masked before anything else
# happens to them, so a later failure cannot echo them into the log.
export_value() {
  local name="$1" value="$2" secret="${3:-no}"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    if [[ "${secret}" == "secret" ]]; then
      echo "::add-mask::${value}"
    fi
    echo "${name}=${value}" >>"${GITHUB_ENV}"
    # Deliberately no env file in CI. GITHUB_ENV already carries these to the
    # following steps, and writing an API token into the workspace would put it
    # one careless upload-artifact step away from being published.
    return
  fi
  printf 'export %s=%q\n' "${name}" "${value}" >>"${env_file}"
}

wait_for_healthy() {
  echo "integration-stack: waiting for containers to report healthy (<= ${HEALTH_TIMEOUT}s)"
  if ! compose up -d --wait --wait-timeout "${HEALTH_TIMEOUT}"; then
    dump_logs
    die "containers did not become healthy within ${HEALTH_TIMEOUT}s. Paperless failed to boot; the logs above are the reason."
  fi
}

wait_for_token() {
  # Progress goes to stderr: this function's stdout *is* the token.
  echo "integration-stack: waiting for /api/token/ (<= ${TOKEN_TIMEOUT}s)" >&2
  local deadline=$((SECONDS + TOKEN_TIMEOUT)) body token
  while ((SECONDS < deadline)); do
    # --fail keeps a 4xx from being parsed as a token; the body is only ever
    # piped into jq, never echoed, because it contains the token itself.
    if body="$(curl -sS --fail --max-time 10 \
      -X POST "${base_url}/api/token/" \
      -H 'Content-Type: application/json' \
      -d "{\"username\":\"${admin_user}\",\"password\":\"${PAPERLESS_IT_ADMIN_PASSWORD}\"}" 2>/dev/null)"; then
      token="$(printf '%s' "${body}" | jq -r '.token // empty')"
      if [[ -n "${token}" ]]; then
        printf '%s' "${token}"
        return 0
      fi
    fi
    sleep 3
  done
  dump_logs
  die "POST /api/token/ did not return a token within ${TOKEN_TIMEOUT}s. Either the superuser was never created (check PAPERLESS_ADMIN_USER/PAPERLESS_ADMIN_PASSWORD in the logs above) or the API is not serving."
}

wait_for_status() {
  local token="$1"
  echo "integration-stack: waiting for /api/status/ to report db+redis+celery OK (<= ${STATUS_TIMEOUT}s)"
  local deadline=$((SECONDS + STATUS_TIMEOUT)) body last=""
  while ((SECONDS < deadline)); do
    if body="$(curl -sS --fail --max-time 10 "${base_url}/api/status/" \
      -H "Authorization: Token ${token}" \
      -H 'Accept: application/json; version=9' 2>/dev/null)"; then
      # Only the three status strings are read out of the payload — the rest of
      # /api/status/ carries instance detail that has no business in a CI log.
      last="$(printf '%s' "${body}" | jq -r \
        '[.database.status // "?", .tasks.redis_status // "?", .tasks.celery_status // "?"] | @tsv')"
      if [[ "${last}" == "$(printf 'OK\tOK\tOK')" ]]; then
        echo "integration-stack: status OK (database, redis, celery)"
        return 0
      fi
    fi
    sleep 3
  done
  echo "integration-stack: last observed status (database, redis, celery): ${last:-<no response>}" >&2
  dump_logs
  die "/api/status/ did not report all of database, Redis and Celery healthy within ${STATUS_TIMEOUT}s. The consumer would not be able to process an upload, so the suite would fail for the wrong reason."
}

cmd_up() {
  need docker
  need curl
  need jq
  : "${PAPERLESS_IT_VERSION:?set PAPERLESS_IT_VERSION to the Paperless-ngx tag under test, e.g. 3.1.3}"

  # The admin password is generated here unless the caller supplies one. That
  # keeps any credential out of the repository, out of the workflow file and
  # out of the repository's Actions secrets: this instance lives for one run,
  # is bound to loopback, and nothing but this script ever needs the password.
  if [[ -z "${PAPERLESS_IT_ADMIN_PASSWORD:-}" ]]; then
    if [[ -n "${PAPERLESS_IT_ADMIN_PASSWORD_FILE:-}" ]]; then
      [[ -r "${PAPERLESS_IT_ADMIN_PASSWORD_FILE}" ]] ||
        die "PAPERLESS_IT_ADMIN_PASSWORD_FILE is set but not readable"
      PAPERLESS_IT_ADMIN_PASSWORD="$(tr -d '\r\n' <"${PAPERLESS_IT_ADMIN_PASSWORD_FILE}")"
    else
      need openssl
      PAPERLESS_IT_ADMIN_PASSWORD="$(openssl rand -hex 24)"
    fi
    export PAPERLESS_IT_ADMIN_PASSWORD
  fi
  [[ -n "${PAPERLESS_IT_ADMIN_PASSWORD}" ]] || die "the admin password resolved to an empty string"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::add-mask::${PAPERLESS_IT_ADMIN_PASSWORD}"; fi

  local started=$SECONDS
  if [[ -z "${GITHUB_ACTIONS:-}" ]]; then
    : >"${env_file}"
    chmod 600 "${env_file}"
  fi

  # Pulling as its own step, and *not* tolerating a failure: a tag that does
  # not exist upstream would otherwise surface much later as "Paperless failed
  # to boot", which is both wrong and the hardest kind of error to chase.
  if ! compose pull --quiet; then
    die "could not pull the images for Paperless-ngx '${PAPERLESS_IT_VERSION}'. Check that ghcr.io/paperless-ngx/paperless-ngx:${PAPERLESS_IT_VERSION} exists and is a published release tag."
  fi
  wait_for_healthy

  local token
  token="$(wait_for_token)"
  # Mask immediately, before the token can reach any other command's output.
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::add-mask::${token}"; fi

  wait_for_status "${token}"

  export_value PAPERLESS_TEST_URL "${base_url}"
  export_value PAPERLESS_TEST_TOKEN "${token}" secret
  export_value PAPERLESS_TEST_UPLOAD "1"
  export_value PAPERLESS_TEST_PAPERLESS_VERSION "${PAPERLESS_IT_VERSION}"

  echo "integration-stack: Paperless-ngx ${PAPERLESS_IT_VERSION} ready at ${base_url} in $((SECONDS - started))s"
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "integration-stack: PAPERLESS_TEST_URL/_TOKEN/_UPLOAD exported to later steps via GITHUB_ENV"
  else
    echo "integration-stack: credentials written to ${env_file} (gitignored); run: eval \"\$(./scripts/integration-stack.sh env)\""
  fi
}

# Run the integration suite, refusing to report success unless it actually
# talked to Paperless.
#
# This exists because `vitest` exits 0 when every test skips, and the suite
# skips itself when PAPERLESS_TEST_URL is unset — by design, so that `npm test`
# on a laptop stays hermetic. In CI that means a green job proves nothing on
# its own: the only thing standing between "ran 32 tests against a real
# instance" and "ran none and said success" is that `up` happened to exit 0.
# That chain is sound and asserted nowhere, which is precisely the kind of
# unverified claim this whole lane exists to stamp out.
#
# So two separate guards, because they are two separate claims:
#
#   1. the URL is set — catches a change to how the stack exports it;
#   2. tests actually passed — catches the case where the URL is set but the
#      suite skipped anyway, which guard 1 cannot see (rename the variable the
#      suite reads and guard 1 still passes while every test skips).
cmd_test() {
  need jq
  : "${PAPERLESS_TEST_URL:?is not set, so the integration suite would skip every test and still exit 0. Bring a stack up first (integration-stack.sh up), or stop calling this from a job that never started one.}"

  local report="${TMPDIR:-/tmp}/vitest-integration-report.json"
  local status=0
  npm run test:integration -- \
    --reporter=default --reporter=json --outputFile.json="${report}" || status=$?

  if [[ ! -f "${report}" ]]; then
    die "vitest wrote no JSON report to ${report}; cannot confirm that any test ran."
  fi

  local passed
  passed="$(jq -r '.numPassedTests // 0' "${report}")"
  echo "integration-stack: ${passed} integration test(s) passed"

  if ((status != 0)); then
    return "${status}"
  fi

  if ((passed < 1)); then
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
      echo "::error::The integration suite reported success without running a single test."
    fi
    die "the integration suite passed 0 tests. PAPERLESS_TEST_URL was set, so it skipped for some other reason — this must never be reported as a successful run against a live Paperless-ngx."
  fi
}

cmd_env() {
  [[ -f "${env_file}" ]] || die "no ${env_file}; run './scripts/integration-stack.sh up' first"
  cat "${env_file}"
}

cmd_down() {
  need docker
  # `down -v` rather than `stop`: the instance is disposable by design and
  # leaving it running would let one run's fixtures leak into the next.
  PAPERLESS_IT_VERSION="${PAPERLESS_IT_VERSION:-unused}" \
    PAPERLESS_IT_ADMIN_PASSWORD="${PAPERLESS_IT_ADMIN_PASSWORD:-unused}" \
    compose down -v --remove-orphans
  rm -f "${env_file}"
}

cmd_logs() {
  PAPERLESS_IT_VERSION="${PAPERLESS_IT_VERSION:-unused}" \
    PAPERLESS_IT_ADMIN_PASSWORD="${PAPERLESS_IT_ADMIN_PASSWORD:-unused}" \
    compose logs "$@"
}

case "${1:-}" in
  up) cmd_up ;;
  test) cmd_test ;;
  env) cmd_env ;;
  down) cmd_down ;;
  logs) shift; cmd_logs "$@" ;;
  *)
    die "usage: $(basename "$0") {up|test|env|down|logs}"
    ;;
esac
