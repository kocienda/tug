#!/usr/bin/env bash
#
# setup-dev-signing.sh — verify the per-machine Apple Developer ID
# Application code-signing identity is installed in the login
# keychain.
#
# Under the multi-instance signing model (see [D11] in
# dash/tug-multi-instance.md), every Tug build signs with the
# user's Apple Developer ID Application certificate. The cert has a
# designated requirement that is stable across rebuilds — so TCC
# Accessibility grants persist instead of being invalidated on every
# `xcodebuild` pass (the old, ad-hoc-signed failure mode).
#
# This script is verification, not provisioning. The certificate is
# installed once via Xcode → Settings → Accounts → (team) → Manage
# Certificates → "+" → "Developer ID Application", which generates
# the CSR, uploads it, downloads the cert, and stashes the private
# key in the login keychain — all in one click. There is no openssl,
# no .p12 file, no manual CSR plumbing.
#
# History: this script previously generated a self-signed `Tug Dev`
# identity via openssl. That worked but had a brittleness: every
# regeneration of the cert produced a new public key and therefore
# a new designated requirement, silently invalidating any TCC grant
# already tied to the prior cert. Real Developer ID certs are
# signed by an Apple intermediate and have a DR that survives
# rebuilds; this is the right shape for daily-iteration UX.

set -euo pipefail

# Match the cert with a real (Apple-signed) chain via `-v`. Unlike
# the prior self-signed flow, Developer ID certs DO chain to a
# system-trusted root, so `-v` filters them in correctly.
if security find-identity -v -p codesigning 2>/dev/null \
    | grep -q "Developer ID Application:"; then
    IDENTITY="$(
        security find-identity -v -p codesigning 2>/dev/null \
            | awk -F'"' '/Developer ID Application:/ {print $2; exit}'
    )"
    echo "✓ Developer ID Application identity installed in login keychain:"
    echo "    $IDENTITY"
    exit 0
fi

# Missing identity. The plan's #apple-prereqs section documents the
# five-step Apple developer account setup; the message below covers
# the user-action steps in the order they happen.
cat >&2 <<'EOF'

error: no Developer ID Application certificate found in the login keychain.

This is the one-time per-machine identity used to sign every Tug
build. Set up via Xcode (no openssl, no manual CSR — one click):

  1. Open Xcode.
  2. Xcode → Settings → Accounts.
  3. Select your Apple ID; if it's not listed, add it.
  4. Select your team (Z67582R5Y8 — Kenneth Kocienda).
  5. Click "Manage Certificates...".
  6. Click the "+" button → "Developer ID Application".
  7. Xcode generates the CSR, uploads, downloads, and installs the
     cert + private key in your login keychain.

Re-run this script to verify the install. If you still see this
error, check Keychain Access — the cert may have landed in a
non-login keychain, in which case drag it into 'login'.

Reference: https://developer.apple.com/help/account/create-certificates/create-developer-id-certificates
EOF
exit 1
