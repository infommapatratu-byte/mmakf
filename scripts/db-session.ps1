# Set DATABASE_URL for this PowerShell session, safely.
#
# WHY THIS EXISTS. The obvious instruction — "run $env:DATABASE_URL = '<your
# connection string>'" — has two failure modes and both have happened here:
#
#   1. The placeholder gets pasted literally, and postgres.js dies with
#      ERR_INVALID_URL and input: '<your connection string>'. The error names
#      the mistake but only after four commands have each failed the same way.
#   2. The connection string ends up in the shell's history and scrollback,
#      where a screen-share or a pasted transcript leaks it.
#
# This prompts for the value with the input masked, checks that it actually
# parses BEFORE anything tries to connect, and never echoes it.
#
# ─────────────────────────────────────────────────────────────────────────────
# IT MUST BE DOT-SOURCED
# ─────────────────────────────────────────────────────────────────────────────
#
#   . .\scripts\db-session.ps1
#     ^ the leading dot and space are the whole point
#
# Without the dot, PowerShell runs this in a CHILD process, sets the variable
# there, and throws the process away on exit — so your own session still has no
# DATABASE_URL and the next npm command fails exactly as before. A child cannot
# set its parent's environment; that is an OS rule, not a PowerShell quirk.
#
# The variable lives for this window only. Close it and the value is gone, which
# is the intended lifetime for a production credential on a developer machine.

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host 'MMAKF — database session' -ForegroundColor Cyan
Write-Host '────────────────────────' -ForegroundColor Cyan
Write-Host 'Paste the connection string. It will not be shown as you type.'
Write-Host 'It should begin with postgres:// or postgresql://'
Write-Host ''

$secure = Read-Host -Prompt 'DATABASE_URL' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$plain = $plain.Trim()

# ── Validate before connecting ──────────────────────────────────────────────
#
# Every check below reports what is wrong WITHOUT printing the value. A
# credential echoed back into the terminal to prove it was received is a
# credential in the scrollback.

if ([string]::IsNullOrWhiteSpace($plain)) {
    Write-Host 'Nothing entered. DATABASE_URL was not set.' -ForegroundColor Red
    return
}

if ($plain -match '^[<\[].*[>\]]$') {
    Write-Host 'That looks like a placeholder, not a connection string.' -ForegroundColor Red
    Write-Host 'Paste the real value from your database provider.' -ForegroundColor Red
    return
}

if ($plain -notmatch '^postgres(ql)?://') {
    Write-Host 'That does not start with postgres:// or postgresql://' -ForegroundColor Red
    Write-Host 'Nothing was set. Check you copied the whole string.' -ForegroundColor Red
    return
}

try {
    $uri = [System.Uri]$plain
} catch {
    Write-Host 'That is not a parseable URL, so postgres.js would reject it too.' -ForegroundColor Red
    Write-Host 'Nothing was set.' -ForegroundColor Red
    return
}

$env:DATABASE_URL = $plain

# ── The CA certificate, only if the provider needs one ──────────────────────
#
# Supabase's pooler chains to "Supabase Root 2021 CA", which no Node trust store
# carries — so a verified connection fails closed with SELF_SIGNED_CERT_IN_CHAIN
# until the root is supplied. That is the correct failure: the answer is to
# supply the root, never to stop verifying.
#
# Two cases need NO certificate at all, so this is skippable by design:
#   · the connection string already carries an sslmode= parameter, which wins
#   · the provider chains to a public root (most managed Postgres does)

$hasSslMode = $plain -match '[?&]sslmode='

Write-Host ''
Write-Host ('Host      : ' + $uri.Host) -ForegroundColor Green
Write-Host ('Database  : ' + $uri.AbsolutePath.TrimStart('/')) -ForegroundColor Green
if ($hasSslMode) {
    Write-Host 'TLS       : sslmode in the URL — it wins, no certificate needed' -ForegroundColor Green
} else {
    Write-Host 'TLS       : certificate will be verified against public roots' -ForegroundColor Green
}
Write-Host ''

# ── THE CERTIFICATE, LOADED RATHER THAN EXPLAINED ────────────────────────
#
# This used to print an instruction with a path the operator had to substitute,
# and every command run before they did it failed the same way:
# SELF_SIGNED_CERT_IN_CHAIN, which reads as a credentials problem and is not one.
# reset-password got as far as PRINTING A NEW PASSWORD under its cautious
# 'probably not changed' branch, and the operator then spent an evening typing a
# credential that had never been written, into a form that could only say
# 'Invalid email or password'.
#
# A certificate sitting in the project root is not a thing to tell somebody
# about. It is a thing to load.

if (-not $hasSslMode) {
    $root = Split-Path -Parent $PSScriptRoot

    if ($env:DATABASE_CA_CERT) {
        Write-Host 'CA        : DATABASE_CA_CERT already set in this session' -ForegroundColor Green
        Write-Host ''
    } else {
        # The name this repository writes, first; then any single certificate the
        # operator has dropped in the root themselves. MORE THAN ONE AND IT PICKS
        # NONE — guessing which root to trust is the one decision this script must
        # never make on its own.
        $preferred = Join-Path $root 'supabase-root-2021.crt'
        $found = $null
        $ambiguous = $false

        if (Test-Path $preferred) {
            $found = $preferred
        } else {
            $certs = @(Get-ChildItem -Path (Join-Path $root '*') -File -Include *.crt, *.pem -ErrorAction SilentlyContinue)
            if ($certs.Count -eq 1) {
                $found = $certs[0].FullName
            } elseif ($certs.Count -gt 1) {
                $ambiguous = $true
                Write-Host 'CA        : several certificates in the project root, so none was chosen:' -ForegroundColor Yellow
                foreach ($c in $certs) { Write-Host ('              ' + $c.Name) -ForegroundColor Yellow }
                Write-Host '            Set it yourself:  $env:DATABASE_CA_CERT = Get-Content <file> -Raw' -ForegroundColor Yellow
                Write-Host ''
            }
        }

        if ($found) {
            $pem = Get-Content $found -Raw
            if ($pem -match '-----BEGIN CERTIFICATE-----') {
                $env:DATABASE_CA_CERT = $pem
                Write-Host ('CA        : loaded from ' + (Split-Path -Leaf $found)) -ForegroundColor Green
                Write-Host ''
            } else {
                Write-Host ('CA        : ' + (Split-Path -Leaf $found) + ' holds no PEM certificate, so it was ignored') -ForegroundColor Yellow
                Write-Host ''
            }
        } elseif (-not $ambiguous) {
            Write-Host 'If a command fails with SELF_SIGNED_CERT_IN_CHAIN, your provider uses a'
            Write-Host 'private root. Download its CA certificate (Supabase: Project Settings >'
            Write-Host 'Database > SSL Configuration > Download certificate), save it into this'
            Write-Host 'folder, and dot-source this script again — it will be picked up.'
            Write-Host ''
        }
    }
}

Write-Host 'DATABASE_URL is set for this window only. Next:' -ForegroundColor Cyan
Write-Host ''
Write-Host '    npm run db:status        # read-only: which migrations are pending'
Write-Host '    npm run db:migrate       # applies them'
Write-Host '    npm run library:seed     # populates the technical library (idempotent)'
Write-Host '    npm run library:status   # read-only: counts what landed'
Write-Host ''

Remove-Variable plain -ErrorAction SilentlyContinue
