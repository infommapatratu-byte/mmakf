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

# A PLACEHOLDER INSIDE THE STRING, WHICH IS THE ONE THAT ACTUALLY HAPPENS.
#
# The check above catches a value that is ENTIRELY a placeholder. Supabase's own
# Connect dialog hands out the other shape:
#
#   postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
#
# and that string parses, passes every check below it, reaches the server and
# fails as `password authentication failed for user "postgres.<ref>"` — which
# reads as a WRONG password rather than as one never substituted. The operator
# then goes looking for the right password, which they may already have had.
#
# Word characters are required between the brackets so an IPv6 literal host
# ([2001:db8::1]) is not mistaken for a placeholder. That has its own failure and
# its own note in DEPLOYMENT.md section 3 step 1.
if ($plain -match '[<\[][A-Za-z][A-Za-z0-9 _-]*[>\]]') {
    Write-Host ('That string still contains a placeholder: ' + $Matches[0]) -ForegroundColor Red
    Write-Host 'Substitute the real value before pasting. Nothing was set.' -ForegroundColor Red
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
Write-Host ('Port      : ' + $uri.Port) -ForegroundColor Green
Write-Host ('Database  : ' + $uri.AbsolutePath.TrimStart('/')) -ForegroundColor Green

# THE TWO POOLER STRINGS DIFFER ONLY IN THE PORT, and DEPLOYMENT.md calls that
# one digit the mistake to expect. 6543 is the transaction pooler the APP uses;
# 5432 is the session pooler an OPERATOR uses. Plain DML runs over either, so
# user:list and friends would work — but db:migrate cannot, because the DDL
# transaction each migration opens needs a session the pooler will not hold.
# Said here rather than left to the failure, which arrives mid-migration.
if ($uri.Port -eq 6543) {
    Write-Host ''
    Write-Host 'NOTE      : 6543 is the TRANSACTION pooler — the string the app uses.' -ForegroundColor Yellow
    Write-Host '            Reads and plain DML work (user:list, user:status, backup),' -ForegroundColor Yellow
    Write-Host '            but db:migrate needs the SESSION pooler: same host, port 5432.' -ForegroundColor Yellow
}
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
