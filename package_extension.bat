@echo off
chcp 65001 >nul
REM Package extension files to dist directory
echo ========================================
echo Packaging extension files...
echo ========================================
echo.

REM Create dist directory
if exist "dist" (
    echo Cleaning old dist directory...
    rmdir /s /q "dist"
)
mkdir "dist"

REM Copy core files
echo Copying core files...
copy "manifest.json" "dist\" >nul && echo   [OK] manifest.json
copy "background.js" "dist\" >nul && echo   [OK] background.js
copy "content.js" "dist\" >nul && echo   [OK] content.js
copy "content.css" "dist\" >nul && echo   [OK] content.css
copy "test.html" "dist\" >nul && echo   [OK] test.html
copy "test.js" "dist\" >nul && echo   [OK] test.js
copy "popup.html" "dist\" >nul && echo   [OK] popup.html
copy "popup.js" "dist\" >nul && echo   [OK] popup.js
copy "main.html" "dist\" >nul && echo   [OK] main.html
copy "main.js" "dist\" >nul && echo   [OK] main.js
copy "options.html" "dist\" >nul && echo   [OK] options.html
copy "options.js" "dist\" >nul && echo   [OK] options.js

REM Copy dictionary files (if exist)
echo.
echo Checking dictionary files...
if exist "offline_dict_full.json" (
    echo   [OK] offline_dict_full.json
    copy "offline_dict_full.json" "dist\" >nul
) else (
    echo   [SKIP] offline_dict_full.json (not found)
)

if exist "offline_dict_full_lemma_map.json" (
    echo   [OK] offline_dict_full_lemma_map.json
    copy "offline_dict_full_lemma_map.json" "dist\" >nul
) else (
    echo   [SKIP] offline_dict_full_lemma_map.json (not found)
)

REM Copy README files (if exist)
if exist "README.md" (
    copy "README.md" "dist\" >nul
    echo   [OK] README.md
)

copy "package_files.txt" "dist\" >nul

echo.
echo ========================================
echo Package completed!
echo ========================================
echo.
echo Files packaged to: dist directory
echo.
echo Installation steps:
echo   1. Copy the 'dist' folder to target machine
echo   2. Open Chrome/Edge, go to chrome://extensions/
echo   3. Enable "Developer mode"
echo   4. Click "Load unpacked"
echo   5. Select the 'dist' folder
echo.
echo For offline dictionary:
echo   - Dictionary files are already in dist folder
echo   - Import them in extension settings page
echo.
pause
