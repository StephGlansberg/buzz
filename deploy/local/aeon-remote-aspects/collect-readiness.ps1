[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("fama", "opulentis")]
  [string] $Aspect,

  [Parameter(Mandatory = $true)]
  [string] $IdentityMapPath,

  [Parameter(Mandatory = $true)]
  [string] $RuntimeMapPath,

  [Parameter(Mandatory = $false)]
  [string] $PolicyEvidenceMapPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Read-JsonFile {
  param([string] $Path)
  if (-not [System.IO.Path]::IsPathRooted($Path)) {
    throw "input path must be absolute"
  }
  return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-Sha256 {
  param([string] $Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Convert-ToSid {
  param([object] $Identity)
  $reference =
    if ($Identity -is [System.Security.Principal.IdentityReference]) {
      $Identity
    } else {
      [System.Security.Principal.NTAccount]::new([string] $Identity)
    }
  return $reference.Translate([System.Security.Principal.SecurityIdentifier]).Value
}

function Get-SecretPosture {
  param(
    [string] $Reference,
    [string] $Path,
    [string] $CurrentUserSid
  )
  $result = [ordered]@{
    reference = $Reference
    exists = $false
    regular_file = $false
    reparse_point = $null
    owner_sid_matches = $null
    dacl_present = $null
    restrictive_dacl = $null
    unexpected_allow_sids = @()
  }
  if (-not [System.IO.Path]::IsPathRooted($Path)) {
    return [pscustomobject] $result
  }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) {
    return [pscustomobject] $result
  }
  $result.exists = $true
  $result.regular_file = -not $item.PSIsContainer
  $result.reparse_point =
    [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
  $acl = Get-Acl -LiteralPath $Path
  $ownerSid = Convert-ToSid $acl.Owner
  $result.owner_sid_matches = $ownerSid -eq $CurrentUserSid
  $rawDescriptor =
    [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl)
  $result.dacl_present = $null -ne $rawDescriptor.DiscretionaryAcl
  $allowed = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  [void] $allowed.Add($CurrentUserSid)
  [void] $allowed.Add("S-1-5-18")
  [void] $allowed.Add("S-1-5-32-544")
  $unexpected = @(
    $acl.Access |
      Where-Object { $_.AccessControlType -eq "Allow" } |
      ForEach-Object { Convert-ToSid $_.IdentityReference } |
      Where-Object { -not $allowed.Contains($_) } |
      Sort-Object -Unique
  )
  $result.unexpected_allow_sids = $unexpected
  $result.restrictive_dacl = (
    $result.dacl_present -and $unexpected.Count -eq 0
  )
  return [pscustomobject] $result
}

function Get-ArtifactPosture {
  param([string] $Reference, [string] $Path)
  if (-not [System.IO.Path]::IsPathRooted($Path)) {
    return [pscustomobject]@{
      reference = $Reference
      exists = $false
      sha256 = $null
    }
  }
  $exists = Test-Path -LiteralPath $Path -PathType Leaf
  return [pscustomobject]@{
    reference = $Reference
    exists = $exists
    sha256 = if ($exists) { Get-Sha256 $Path } else { $null }
  }
}

function Get-PolicyGate {
  param(
    [string] $Aspect,
    [string] $SessionKey,
    [object] $EvidenceMap
  )
  $gate = [ordered]@{
    evidence_status = "unknown"
    evidence_schema = $null
    evidence_sha256_matches = $null
    session_key_matches = $null
    public_social_mutation = "unknown"
    capital_mutation = "unknown"
    reviewed_by_present = $false
    reviewed_at_present = $false
    declaration_complete = $false
  }
  if ($null -eq $EvidenceMap) {
    return [pscustomobject] $gate
  }
  $entry = $EvidenceMap.workers.$Aspect
  if ($null -eq $entry) {
    return [pscustomobject] $gate
  }
  $gate.evidence_schema = $EvidenceMap.schema
  $gate.session_key_matches = $entry.session_key -eq $SessionKey
  $gate.public_social_mutation = [string] $entry.public_social_mutation
  $gate.capital_mutation = [string] $entry.capital_mutation
  $gate.reviewed_by_present = -not [string]::IsNullOrWhiteSpace($entry.reviewed_by)
  $gate.reviewed_at_present = -not [string]::IsNullOrWhiteSpace($entry.reviewed_at)
  $evidencePath = [string] $entry.tools_effective_path
  $evidenceExists = (
    [System.IO.Path]::IsPathRooted($evidencePath) -and
    (Test-Path -LiteralPath $evidencePath -PathType Leaf)
  )
  if ($evidenceExists) {
    $gate.evidence_sha256_matches =
      (Get-Sha256 $evidencePath) -eq ([string] $entry.tools_effective_sha256).ToLowerInvariant()
  } else {
    $gate.evidence_sha256_matches = $false
  }
  $gate.evidence_status = if ($evidenceExists) { "present" } else { "missing" }
  $gate.declaration_complete = (
    $EvidenceMap.schema -eq "aeon_buzz_remote_windows_policy_evidence_v1" -and
    $gate.evidence_sha256_matches -and
    $gate.session_key_matches -and
    $gate.public_social_mutation -eq "absent_or_refused" -and
    $gate.capital_mutation -eq "absent_or_refused" -and
    $gate.reviewed_by_present -and
    $gate.reviewed_at_present
  )
  return [pscustomobject] $gate
}

$identity = Read-JsonFile $IdentityMapPath
$runtime = Read-JsonFile $RuntimeMapPath
$policyEvidence =
  if ([string]::IsNullOrWhiteSpace($PolicyEvidenceMapPath)) {
    $null
  } else {
    Read-JsonFile $PolicyEvidenceMapPath
  }
$currentSid =
  [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$runtimeSidMatches =
  ([string] $runtime.windowsUserSid) -eq $currentSid
$relayUri = [Uri] ([string] $runtime.relayUrl)
$relayAddress = $null
$relayHostIsIp =
  [System.Net.IPAddress]::TryParse($relayUri.DnsSafeHost, [ref] $relayAddress)
$relayIsLoopback = (
  $relayUri.DnsSafeHost -eq "localhost" -or
  ($relayHostIsIp -and [System.Net.IPAddress]::IsLoopback($relayAddress)) -or
  (
    $relayHostIsIp -and
    $relayAddress.IsIPv4MappedToIPv6 -and
    [System.Net.IPAddress]::IsLoopback($relayAddress.MapToIPv4())
  )
)
$relayInputValid = (
  $relayUri.Scheme -eq "wss" -and
  -not [string]::IsNullOrWhiteSpace($relayUri.Host) -and
  -not $relayIsLoopback -and
  [string]::IsNullOrEmpty($relayUri.UserInfo) -and
  $relayUri.AbsolutePath -eq "/" -and
  [string]::IsNullOrEmpty($relayUri.Query) -and
  [string]::IsNullOrEmpty($relayUri.Fragment)
)
$allowedAspects = @("fama", "opulentis")
$verifiedGatewayUrls = @{
  fama = "ws://127.0.0.1:18821"
  opulentis = "ws://127.0.0.1:18820"
}
$workers = [ordered]@{}

foreach ($aspect in $allowedAspects) {
  $member = $identity.members.$aspect
  $channel = $identity.channels."aspect_$aspect"
  $seat = $runtime.workers.$aspect
  $otherAspect = if ($aspect -eq "fama") { "opulentis" } else { "fama" }
  $otherMember = $identity.members.$otherAspect
  $otherChannel = $identity.channels."aspect_$otherAspect"
  $sessionKey = [string] $member.session_key
  $privateKey = Get-SecretPosture `
    -Reference "$aspect.private_key" `
    -Path ([string] $member.secret_ref) `
    -CurrentUserSid $currentSid
  $gatewayToken = Get-SecretPosture `
    -Reference "$aspect.gateway_token" `
    -Path ([string] $seat.gatewayTokenFile) `
    -CurrentUserSid $currentSid
  $policy = Get-PolicyGate `
    -Aspect $aspect `
    -SessionKey $sessionKey `
    -EvidenceMap $policyEvidence
  $gatewayUri = [Uri] ([string] $seat.gatewayUrl)
  $gatewayBaselineMatches =
    ([string] $seat.gatewayUrl) -eq $verifiedGatewayUrls[$aspect]
  $gatewayReachable = (
    $gatewayUri.Host -eq "127.0.0.1" -and
    (Test-NetConnection `
      -ComputerName $gatewayUri.Host `
      -Port $gatewayUri.Port `
      -InformationLevel Quiet `
      -WarningAction SilentlyContinue)
  )
  $buzzAcp = Get-ArtifactPosture "$aspect.buzz_acp" ([string] $seat.buzzAcpPath)
  $openclaw = Get-ArtifactPosture "$aspect.openclaw" ([string] $seat.openclawPath)
  $roomConfig = Get-ArtifactPosture "$aspect.room_config" ([string] $seat.configPath)
  $basePrompt = Get-ArtifactPosture "$aspect.base_prompt" ([string] $seat.basePromptPath)
  $identityValid = (
    ([string] $identity.members.architect.pubkey_hex) -eq
      "73ac8798fd9cedcc5d24645d7ed49332d94a28f2c937f4c1b638f92bf6e8e91f" -and
    ([string] $member.display_name) -eq
      $(if ($aspect -eq "fama") { "FAMA" } else { "Opulentis" }) -and
    ([string] $member.pubkey_hex) -match "^[0-9a-f]{64}$" -and
    ([string] $member.pubkey_hex) -ne
      ([string] $identity.members.architect.pubkey_hex) -and
    ([string] $member.pubkey_hex) -ne ([string] $otherMember.pubkey_hex) -and
    -not ([string] $member.secret_ref).Equals(
      [string] $otherMember.secret_ref,
      [System.StringComparison]::OrdinalIgnoreCase
    ) -and
    ([string] $channel.channel_id) -match
      "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" -and
    ([string] $channel.channel_id) -ne ([string] $otherChannel.channel_id) -and
    @($channel.members).Count -eq 2 -and
    ([string] $channel.members[0]) -eq "architect" -and
    ([string] $channel.members[1]) -eq $aspect -and
    $sessionKey -eq "agent:$([string] $member.gateway_agent_id):buzz-private"
  )
  $baseReady = (
    $runtimeSidMatches -and
    $relayInputValid -and
    $identityValid -and
    $privateKey.exists -and
    $privateKey.regular_file -and
    -not $privateKey.reparse_point -and
    $privateKey.owner_sid_matches -and
    $privateKey.restrictive_dacl -and
    $gatewayToken.exists -and
    $gatewayToken.regular_file -and
    -not $gatewayToken.reparse_point -and
    $gatewayToken.owner_sid_matches -and
    $gatewayToken.restrictive_dacl -and
    $buzzAcp.exists -and
    $openclaw.exists -and
    $roomConfig.exists -and
    $basePrompt.exists -and
    $gatewayBaselineMatches -and
    $gatewayReachable
  )
  $workers[$aspect] = [pscustomobject]@{
    aspect = $aspect
    session_key = $sessionKey
    gateway_agent_id = [string] $member.gateway_agent_id
    expected_public_key = [string] $member.pubkey_hex
    private_channel_id = [string] $identity.channels."aspect_$aspect".channel_id
    identity_contract_valid = $identityValid
    runtime_user_sid_matches = $runtimeSidMatches
    relay_url = [string] $runtime.relayUrl
    relay_input_valid = $relayInputValid
    relay_live_verified = $false
    private_key = $privateKey
    gateway_token = $gatewayToken
    buzz_acp = $buzzAcp
    openclaw = $openclaw
    room_config = $roomConfig
    base_prompt = $basePrompt
    verified_gateway_url = $verifiedGatewayUrls[$aspect]
    gateway_baseline_matches = $gatewayBaselineMatches
    gateway_loopback_reachable = $gatewayReachable
    mutation_policy = $policy
    base_readiness_passed = $baseReady
    policy_review_ready = $baseReady -and $policy.declaration_complete
    activation_allowed = $false
  }
}

$result = [pscustomobject]@{
  schema = "aeon_buzz_remote_windows_readiness_v1"
  collected_at = [DateTimeOffset]::UtcNow.ToString("o")
  selected_aspect = $Aspect
  current_user_sid = $currentSid
  runtime_user_sid_matches = $runtimeSidMatches
  relay_input_valid = $relayInputValid
  relay_live_verified = $false
  identity_map_sha256 = Get-Sha256 $IdentityMapPath
  runtime_map_sha256 = Get-Sha256 $RuntimeMapPath
  policy_evidence_map_sha256 =
    if ($null -ne $policyEvidence) { Get-Sha256 $PolicyEvidenceMapPath } else { $null }
  required_policy_evidence_schema = "aeon_buzz_remote_windows_policy_evidence_v1"
  required_mutation_decision = "absent_or_refused"
  workers = [pscustomobject] $workers
  all_activation_allowed =
    @($workers.Values | Where-Object { -not $_.activation_allowed }).Count -eq 0
  selected_readiness_passed = $workers[$Aspect].base_readiness_passed
  selected_activation_allowed = $false
}

$result | ConvertTo-Json -Depth 16
if (-not $result.selected_readiness_passed) {
  exit 2
}
