# Package extension files to dist directory
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Packaging extension files..." -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Create dist directory
if (Test-Path "dist") {
    Write-Host "Cleaning old dist directory..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force "dist"
}
New-Item -ItemType Directory -Path "dist" | Out-Null

# Core files list
$coreFiles = @(
    "manifest.json",
    "background.js",
    "content.js",
    "content.css",
    "test.html",
    "test.js",
    "popup.html",
    "popup.js",
    "main.html",
    "main.js",
    "options.html",
    "options.js"
)

# Copy core files
Write-Host "Copying core files..." -ForegroundColor Green
foreach ($file in $coreFiles) {
    if (Test-Path $file) {
        Copy-Item $file "dist\" -Force
        Write-Host "  [OK] $file" -ForegroundColor Gray
    } else {
        Write-Host "  [FAIL] $file (not found)" -ForegroundColor Red
    }
}

# Copy dictionary files (if exist)
Write-Host ""
Write-Host "Checking dictionary files..." -ForegroundColor Green
$dictFiles = @(
    "offline_dict_full.json",
    "offline_dict_full_lemma_map.json"
)

foreach ($file in $dictFiles) {
    if (Test-Path $file) {
        $fileSize = [math]::Round((Get-Item $file).Length / 1MB, 2)
        Write-Host "  [OK] $file ($fileSize MB)" -ForegroundColor Yellow
        Copy-Item $file "dist\" -Force
    } else {
        Write-Host "  [SKIP] $file (not found)" -ForegroundColor Gray
    }
}

# Copy README files (if exist)
if (Test-Path "README.md") {
    Copy-Item "README.md" "dist\" -Force
    Write-Host "  [OK] README.md" -ForegroundColor Gray
}

Copy-Item "package_files.txt" "dist\" -Force

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Package completed!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Files packaged to: dist directory" -ForegroundColor Green
Write-Host ""
Write-Host "Installation steps:" -ForegroundColor Yellow
Write-Host "  1. Copy the 'dist' folder to target machine"
Write-Host "  2. Open Chrome/Edge, go to chrome://extensions/"
Write-Host "  3. Enable 'Developer mode'"
Write-Host "  4. Click 'Load unpacked'"
Write-Host "  5. Select the 'dist' folder"
Write-Host ""
Write-Host "For offline dictionary:" -ForegroundColor Yellow
Write-Host "  - Dictionary files are already in dist folder"
Write-Host "  - Import them in extension settings page"
Write-Host ""
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
