#!/usr/bin/env bash
# HYBA-2011: per-tag Trivy allowlist validator. Same rules as the Jenkins job (HYBA-1832): empty means no allowlist;
# otherwise the text must carry the exact scope line, only the fixed entry shape, an expiry within 30 days per id,
# and must never except an id that has a fix. Writes trivy-allowlist.yaml in the working directory only when accepted.
# Input: TRIVY_IGNORE_YAML (text), ALLOWLIST_SCOPE (image:tag the list is for).
set -euo pipefail
af=trivy-allowlist.yaml
rm -f "$af"
: "${ALLOWLIST_SCOPE:?ALLOWLIST_SCOPE is required}"
if [ -z "$(printf '%s' "${TRIVY_IGNORE_YAML:-}" | tr -d '[:space:]')" ]; then
  echo "allowlist: none (CRITICAL gate unchanged)"
  exit 0
fi
reject() { echo "allowlist rejected: $1"; rm -f "$af"; exit 1; }
case "$TRIVY_IGNORE_YAML" in *$'\r'*) reject "carriage returns are not allowed" ;; esac
printf '%s\n' "$TRIVY_IGNORE_YAML" > "$af"
scope="# scope: ${ALLOWLIST_SCOPE}"
grep -Fxq -- "$scope" "$af" || reject "first-class scope line '$scope' is missing"
today="$(date -u +%F)"; limit="$(date -u -d '+30 days' +%F)"
never='CVE-2026-90711 CVE-2024-24790 CVE-2025-68121 CVE-2026-59873'
n=0; st=0; ex=0; seen_vuln=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    ''|'#'*) continue ;;
  esac
  if [ "$line" = 'vulnerabilities:' ]; then seen_vuln=1; continue; fi
  if printf '%s' "$line" | grep -Eq '^  - id: (CVE-[0-9]{4}-[0-9]{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$'; then
    id="${line#  - id: }"
    for bad in $never; do [ "$id" != "$bad" ] || reject "$id has a fix and cannot be excepted"; done
    if [ "$n" -gt 0 ] && { [ "$st" -ne 1 ] || [ "$ex" -ne 1 ]; }; then reject "entry before $id needs exactly one statement and one expired_at"; fi
    n=$((n + 1)); st=0; ex=0; continue
  fi
  if [ "$n" -gt 0 ] && printf '%s' "$line" | grep -Eq '^    statement: "[^"]+"$'; then st=$((st + 1)); continue; fi
  if [ "$n" -gt 0 ] && printf '%s' "$line" | grep -Eq '^    paths: [[]"[A-Za-z0-9_./@+-]+"(, "[A-Za-z0-9_./@+-]+")*[]]$'; then continue; fi
  if [ "$n" -gt 0 ] && printf '%s' "$line" | grep -Eq '^    expired_at: [0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
    d="${line#    expired_at: }"
    date -u -d "$d" +%F > /dev/null 2>&1 || reject "'$d' is not a date"
    if [[ "$d" < "$today" ]]; then reject "$d is already expired"; fi
    if [[ "$d" > "$limit" ]]; then reject "$d is more than 30 days away (limit $limit)"; fi
    ex=$((ex + 1)); continue
  fi
  reject "unexpected line: $(printf '%s' "$line" | cut -c1-80)"
done < "$af"
[ "$seen_vuln" -eq 1 ] && [ "$n" -gt 0 ] || reject "no vulnerabilities entries"
if [ "$st" -ne 1 ] || [ "$ex" -ne 1 ]; then reject "last entry needs exactly one statement and one expired_at"; fi
echo "allowlist accepted: $n id(s), scope ${ALLOWLIST_SCOPE}"
sha256sum "$af"
