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

if (-not $hasSslMode) {
    Write-Host 'If a command later fails with SELF_SIGNED_CERT_IN_CHAIN, your provider'
    Write-Host 'uses a private root. Download its CA certificate (Supabase: Project'
    Write-Host 'Settings > Database > SSL certificate) and then run:'
    Write-Host ''
    Write-Host '    $env:DATABASE_CA_CERT = Get-Content <path-to-the-file-you-downloaded> -Raw' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '(that one does need a real path substituted — there is no file to guess)'
    Write-Host ''
}

Write-Host 'DATABASE_URL is set for this window only. Next:' -ForegroundColor Cyan
Write-Host ''
Write-Host '    npm run db:status        # read-only: which migrations are pending'
Write-Host '    npm run db:migrate       # applies them'
Write-Host '    npm run library:seed     # populates the technical library (idempotent)'
Write-Host '    npm run library:status   # read-only: counts what landed'
Write-Host ''

Remove-Variable plain -ErrorAction SilentlyContinue
