param(
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"

$ExtensionRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$PackageJsonPath = Join-Path $ExtensionRoot "package.json"
$Package = Get-Content -LiteralPath $PackageJsonPath -Raw | ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $ExtensionRoot "dist"
}

$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$StageRoot = Join-Path $OutputDirectory "vsix-stage"
$ExtensionStage = Join-Path $StageRoot "extension"
$VsixPath = Join-Path $OutputDirectory "$($Package.name)-$($Package.version).vsix"
$ZipPath = Join-Path $OutputDirectory "$($Package.name)-$($Package.version).zip"

if (Test-Path -LiteralPath $StageRoot) {
  Remove-Item -LiteralPath $StageRoot -Recurse -Force
}
if (Test-Path -LiteralPath $VsixPath) {
  Remove-Item -LiteralPath $VsixPath -Force
}
if (Test-Path -LiteralPath $ZipPath) {
  Remove-Item -LiteralPath $ZipPath -Force
}

New-Item -ItemType Directory -Path $ExtensionStage -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $ExtensionRoot "package.json") -Destination $ExtensionStage
Copy-Item -LiteralPath (Join-Path $ExtensionRoot "extension.cjs") -Destination $ExtensionStage
Copy-Item -LiteralPath (Join-Path $ExtensionRoot "README.md") -Destination $ExtensionStage
Copy-Item -LiteralPath (Join-Path $ExtensionRoot "core") -Destination $ExtensionStage -Recurse
Copy-Item -LiteralPath (Join-Path $ExtensionRoot "media") -Destination $ExtensionStage -Recurse

$contentTypes = @"
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="cjs" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml" />
</Types>
"@

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$($Package.name)" Version="$($Package.version)" Publisher="$($Package.publisher)" />
    <DisplayName>$($Package.displayName)</DisplayName>
    <Description xml:space="preserve">$($Package.description)</Description>
    <Tags>tokens,claude,codex,prompt,graph</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($Package.engines.vscode)" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
"@

Set-Content -LiteralPath (Join-Path $StageRoot "[Content_Types].xml") -Value $contentTypes -Encoding UTF8
Set-Content -LiteralPath (Join-Path $StageRoot "extension.vsixmanifest") -Value $manifest -Encoding UTF8

Compress-Archive -Path (Join-Path $StageRoot "*") -DestinationPath $ZipPath -Force
Move-Item -LiteralPath $ZipPath -Destination $VsixPath
Write-Host "Created $VsixPath"
